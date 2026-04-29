import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import envPaths from "env-paths";

import {
  APP_NAME,
  createEmptyConfig,
  parsePersistedConfig,
  AppConfigSchema,
  type AppConfig
} from "../shared/config.js";

type ResolveConfigDirectoryOptions = {
  appName?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
};

type ConfigStoreOptions = {
  appName?: string;
  configDir?: string;
};

type LoadConfigResult = {
  config: AppConfig;
  configFile: string;
  recoveredFromCorruption: boolean;
};

const sameProcessContext = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string
) => platform === process.platform && env === process.env && homeDir === os.homedir();

const selectRuntimeConfigDirectory = (appName: string) => {
  const runtimePaths = envPaths(appName, { suffix: "" });

  if (process.platform === "darwin") {
    return runtimePaths.data;
  }

  return runtimePaths.config;
};

export const resolveConfigDirectory = ({
  appName = APP_NAME,
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform
}: ResolveConfigDirectoryOptions = {}): string => {
  if (sameProcessContext(platform, env, homeDir)) {
    return selectRuntimeConfigDirectory(appName);
  }

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", appName);
  }

  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(homeDir, "AppData", "Roaming"), appName);
  }

  return path.join(env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config"), appName);
};

const getPaths = (options: ConfigStoreOptions = {}) => {
  const configDir = options.configDir ?? resolveConfigDirectory({ appName: options.appName });

  return {
    configDir,
    configFile: path.join(configDir, "config.json"),
    backupFile: path.join(configDir, "config.json.bak")
  };
};

const writeConfigAtomically = async (configFile: string, nextConfig: AppConfig) => {
  await fs.mkdir(path.dirname(configFile), { recursive: true });

  const tempFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, configFile);
};

const backupInvalidConfig = async (configFile: string, backupFile: string) => {
  try {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.rename(configFile, backupFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const timestampedBackup = `${backupFile}.${Date.now()}`;
      await fs.rename(configFile, timestampedBackup);
      return;
    }

    throw error;
  }
};

export const createConfigStore = (options: ConfigStoreOptions = {}) => {
  const paths = getPaths(options);

  const load = async (): Promise<LoadConfigResult> => {
    try {
      const raw = await fs.readFile(paths.configFile, "utf8");
      const parsed = JSON.parse(raw);
      const config = parsePersistedConfig(parsed);

      return {
        config,
        configFile: paths.configFile,
        recoveredFromCorruption: false
      };
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;

      if (fsError.code === "ENOENT") {
        return {
          config: createEmptyConfig(),
          configFile: paths.configFile,
          recoveredFromCorruption: false
        };
      }

      await backupInvalidConfig(paths.configFile, paths.backupFile);

      return {
        config: createEmptyConfig(),
        configFile: paths.configFile,
        recoveredFromCorruption: true
      };
    }
  };

  const save = async (config: AppConfig): Promise<AppConfig> => {
    const nextConfig = AppConfigSchema.parse(config);
    await writeConfigAtomically(paths.configFile, nextConfig);
    return nextConfig;
  };

  const update = async (patch: Partial<AppConfig>) => {
    const { config } = await load();
    return save({
      ...config,
      ...patch,
      version: config.version
    });
  };

  const reset = async () => {
    await fs.rm(paths.configFile, { force: true });
  };

  return {
    load,
    reset,
    save,
    update,
    paths
  };
};
