import path from "node:path";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import type { RepoHandle } from "../common/types.js";
import { TugError } from "../common/errors.js";
import { buildPnpmCommand, formatCommandForDisplay, resolvePnpmCommand } from "../common/package-manager.js";
import { runShellCommand } from "../common/shell.js";

const execFileAsync = promisify(execFile);

const REQUIRED_RELATIVE_PATHS = [
  "e2e-automation/sm-ui-refresh/playwright.config.ts",
  "e2e-automation/sm-ui-refresh/package.json",
  "e2e-automation/sm-ui-refresh/tsconfig.json",
  "e2e-automation/sm-ui-refresh/playwright-helpers/sm"
] as const;

const assertPathExists = async (repoPath: string, relativePath: string) => {
  const absolutePath = path.join(repoPath, relativePath);
  await fs.access(absolutePath).catch(() => {
    throw new TugError(
      "STRUCTURE_INVALID",
      `Required automation path is missing: ${relativePath}`,
      [absolutePath]
    );
  });
};

const parsePackageInfo = async (packageJsonPath: string) => {
  const raw = await fs.readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as {
    name?: string;
    version?: string;
  };

  if (!parsed.name || !parsed.version) {
    throw new TugError("STRUCTURE_INVALID", `Invalid package.json at ${packageJsonPath}`);
  }

  return {
    packageName: parsed.name,
    packageVersion: parsed.version
  };
};

const getGitSha = async (repoPath: string) => {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
};

const getIsDirty = async (repoPath: string) => {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoPath,
      "status",
      "--porcelain",
      "--",
      "e2e-automation/sm-ui-refresh"
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
};

const resolveLockfilePath = async (repoPath: string) => {
  for (const relativePath of ["pnpm-lock.yaml", "package-lock.json"] as const) {
    const absolutePath = path.join(repoPath, relativePath);
    try {
      await fs.access(absolutePath);
      return absolutePath;
    } catch {
      continue;
    }
  }

  return undefined;
};

export const validateRepositoryStructure = async (repoPath: string): Promise<RepoHandle> => {
  for (const requiredPath of REQUIRED_RELATIVE_PATHS) {
    await assertPathExists(repoPath, requiredPath);
  }

  const smRootPath = path.join(repoPath, "e2e-automation", "sm-ui-refresh");
  const packageJsonPath = path.join(smRootPath, "package.json");
  const { packageName, packageVersion } = await parsePackageInfo(packageJsonPath);

  return {
    absPath: repoPath,
    smRootPath,
    packageName,
    packageVersion,
    playwrightConfigPath: path.join(smRootPath, "playwright.config.ts"),
    tsconfigPath: path.join(smRootPath, "tsconfig.json"),
    lockfilePath: await resolveLockfilePath(repoPath),
    packageManagerCommand: await resolvePnpmCommand(repoPath),
    gitSha: await getGitSha(repoPath),
    isDirty: await getIsDirty(repoPath)
  };
};

const findPackageJsonFromResolvedModule = async (resolvedModulePath: string) => {
  let currentPath = path.dirname(resolvedModulePath);

  while (currentPath !== path.dirname(currentPath)) {
    const packageJsonPath = path.join(currentPath, "package.json");
    try {
      const raw = await fs.readFile(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as { name?: string };
      if (parsed.name === "@playwright/test") {
        return packageJsonPath;
      }
    } catch {
      // Keep walking toward the package root.
    }

    currentPath = path.dirname(currentPath);
  }

  return undefined;
};

const resolvePlaywrightPackagePath = async (repo: RepoHandle) => {
  const requireFromPackage = createRequire(path.join(repo.smRootPath, "package.json"));

  try {
    return requireFromPackage.resolve("@playwright/test/package.json");
  } catch {
    try {
      const resolvedModulePath = requireFromPackage.resolve("@playwright/test");
      return await findPackageJsonFromResolvedModule(resolvedModulePath);
    } catch {
      return undefined;
    }
  }
};

const readInstalledPlaywrightVersion = async (repo: RepoHandle) => {
  const playwrightPackagePath = await resolvePlaywrightPackagePath(repo);
  if (!playwrightPackagePath) {
    return undefined;
  }

  const raw = await fs.readFile(playwrightPackagePath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "unknown";
};

const installAutomationDependencies = async (repo: RepoHandle) => {
  if (!repo.lockfilePath || path.basename(repo.lockfilePath) !== "pnpm-lock.yaml") {
    throw new TugError(
      "PLAYWRIGHT_INCOMPATIBLE",
      "Playwright is not installed and the automation repo does not have a supported pnpm-lock.yaml for automatic install.",
      [
        "Run the automation repo package install once, or add/commit pnpm-lock.yaml so TUG can restore dependencies automatically."
      ]
    );
  }

  const command = buildPnpmCommand(repo, ["install", "--frozen-lockfile"]);
  const result = await runShellCommand({
    command,
    cwd: repo.absPath,
    env: {
      ...process.env,
      CI: "true",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0"
    },
    streamPrefix: "[automation install] "
  });

  if (result.exitCode !== 0) {
    throw new TugError(
      "PLAYWRIGHT_INCOMPATIBLE",
      "Unable to install automation repo dependencies automatically.",
      [
        `Command: ${formatCommandForDisplay(command)}`,
        result.stderr.trim() || result.stdout.trim() || "The package manager exited without output."
      ]
    );
  }
};

export const ensurePlaywrightInstalled = async (repo: RepoHandle) => {
  const installedVersion = await readInstalledPlaywrightVersion(repo);
  if (installedVersion) {
    return installedVersion;
  }

  await installAutomationDependencies(repo);

  const bootstrappedVersion = await readInstalledPlaywrightVersion(repo);
  if (bootstrappedVersion) {
    return bootstrappedVersion;
  }

  throw new TugError(
    "PLAYWRIGHT_INCOMPATIBLE",
    "Automation repo dependencies were installed, but @playwright/test is still not resolvable from e2e-automation/sm-ui-refresh.",
    ["Check that @playwright/test is declared for the sm-ui-refresh workspace package."]
  );
};

export const ensureWorkingTreeCleanWhenStrict = (repo: RepoHandle, strict: boolean) => {
  if (strict && repo.isDirty) {
    throw new TugError(
      "WORKING_TREE_DIRTY",
      "Working tree is dirty under e2e-automation/sm-ui-refresh (blocked by --strict)."
    );
  }
};
