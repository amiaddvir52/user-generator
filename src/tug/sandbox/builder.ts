import path from "node:path";
import { promises as fs } from "node:fs";

import type { RepoHandle, SandboxHandle, TransformResult } from "../common/types.js";
import {
  createSandboxDirectory,
  removeSandboxDirectory,
  resolveSetupCacheRoot
} from "../common/paths.js";
import { generatePlaywrightConfig } from "./gen-playwright-config.js";
import { generateTsConfig } from "./gen-tsconfig.js";
import {
  generateSetupCacheCaptureScript,
  generateSetupCachePersistScript,
  SETUP_CACHE_CAPTURE_SCRIPT_NAME,
  SETUP_CACHE_PERSIST_SCRIPT_NAME
} from "./setup-cache-scripts.js";

export const buildSandbox = async ({
  repo,
  fingerprint,
  transform,
  diff,
  runPlan
}: {
  repo: RepoHandle;
  fingerprint: string;
  transform: TransformResult;
  diff: string;
  runPlan: Record<string, unknown>;
}): Promise<SandboxHandle> => {
  const sandboxPath = await createSandboxDirectory({
    fingerprint,
    repoPath: repo.absPath
  });

  const specPath = path.join(sandboxPath, "gen.spec.ts");
  const playwrightConfigPath = path.join(sandboxPath, "playwright.gen.config.ts");
  const tsconfigPath = path.join(sandboxPath, "tsconfig.gen.json");
  const diffPath = path.join(sandboxPath, "diff.patch");
  const runPlanPath = path.join(sandboxPath, "run-plan.json");
  const stdoutLogPath = path.join(sandboxPath, "stdout.log");
  const stderrLogPath = path.join(sandboxPath, "stderr.log");
  const setupCacheCaptureScriptPath = path.join(sandboxPath, SETUP_CACHE_CAPTURE_SCRIPT_NAME);
  const setupCachePersistScriptPath = path.join(sandboxPath, SETUP_CACHE_PERSIST_SCRIPT_NAME);
  const nodeModulesLinkPath = path.join(sandboxPath, "node_modules");
  const repoNodeModulesPath = path.join(repo.smRootPath, "node_modules");
  const setupCacheRoot = resolveSetupCacheRoot();

  try {
    await fs.writeFile(specPath, transform.transformedText, "utf8");
    await fs.writeFile(
      setupCacheCaptureScriptPath,
      generateSetupCacheCaptureScript(),
      { encoding: "utf8", mode: 0o600 }
    );
    await fs.writeFile(
      setupCachePersistScriptPath,
      generateSetupCachePersistScript(),
      { encoding: "utf8", mode: 0o600 }
    );
    await fs.writeFile(
      playwrightConfigPath,
      generatePlaywrightConfig({
        baseConfigPath: repo.playwrightConfigPath,
        fingerprint,
        setupCacheRoot,
        setupCacheCaptureScriptPath,
        setupCachePersistScriptPath
      }),
      "utf8"
    );
    await fs.writeFile(
      tsconfigPath,
      generateTsConfig({
        baseTsconfigPath: repo.tsconfigPath
      }),
      "utf8"
    );
    await fs.writeFile(diffPath, diff, "utf8");
    await fs.writeFile(runPlanPath, `${JSON.stringify(runPlan, null, 2)}\n`, "utf8");
    await fs.writeFile(stdoutLogPath, "", "utf8");
    await fs.writeFile(stderrLogPath, "", "utf8");
    await fs.symlink(repoNodeModulesPath, nodeModulesLinkPath, "junction");
  } catch (error) {
    await removeSandboxDirectory(sandboxPath).catch(() => undefined);
    throw error;
  }

  return {
    path: sandboxPath,
    specPath,
    playwrightConfigPath,
    tsconfigPath,
    diffPath,
    runPlanPath,
    stdoutLogPath,
    stderrLogPath
  };
};

export const cleanupSandbox = async (sandbox: SandboxHandle) => {
  await removeSandboxDirectory(sandbox.path);
};
