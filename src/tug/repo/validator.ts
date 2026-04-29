import path from "node:path";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import type { RepoHandle } from "../common/types.js";
import { TugError } from "../common/errors.js";

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
    gitSha: await getGitSha(repoPath),
    isDirty: await getIsDirty(repoPath)
  };
};

export const ensurePlaywrightInstalled = async (repo: RepoHandle) => {
  const playwrightPackagePath = path.join(repo.smRootPath, "node_modules", "@playwright", "test", "package.json");
  await fs.access(playwrightPackagePath).catch(() => {
    throw new TugError(
      "PLAYWRIGHT_INCOMPATIBLE",
      "Playwright is not installed under e2e-automation/sm-ui-refresh/node_modules."
    );
  });

  const raw = await fs.readFile(playwrightPackagePath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "unknown";
};

export const ensureWorkingTreeCleanWhenStrict = (repo: RepoHandle, strict: boolean) => {
  if (strict && repo.isDirty) {
    throw new TugError(
      "WORKING_TREE_DIRTY",
      "Working tree is dirty under e2e-automation/sm-ui-refresh (blocked by --strict)."
    );
  }
};

