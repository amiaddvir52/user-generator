import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { TugError } from "./errors.js";

const RUNS_DIR_NAME = "runs";
const SETUP_CACHE_DIR_NAME = "setup-cache";

const isInside = (parentPath: string, childPath: string) => {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
};

export const resolveCacheRoot = () => {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "test-user-generator");
  }

  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "test-user-generator");
};

export const resolveRunsRoot = () => path.join(resolveCacheRoot(), RUNS_DIR_NAME);
export const resolveSetupCacheRoot = () => path.join(resolveCacheRoot(), SETUP_CACHE_DIR_NAME);

const sanitizeFingerprint = (fingerprint: string) => fingerprint.replace(/[^a-zA-Z0-9_-]/g, "");

export const createRunId = (fingerprint: string) => {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const fp = sanitizeFingerprint(fingerprint).slice(0, 12) || "unknown";
  return `${iso}-${fp}-${process.pid}`;
};

export const createSandboxDirectory = async ({
  fingerprint,
  repoPath
}: {
  fingerprint: string;
  repoPath: string;
}) => {
  const runsRoot = resolveRunsRoot();
  await fs.mkdir(runsRoot, { recursive: true });

  const runId = createRunId(fingerprint);
  const sandboxPath = path.join(runsRoot, runId);

  if (isInside(repoPath, sandboxPath)) {
    throw new TugError("SANDBOX_COLLISION", "Sandbox path would be created inside the target repository.");
  }

  try {
    const entries = await fs.readdir(sandboxPath);
    if (entries.length > 0) {
      throw new TugError("SANDBOX_COLLISION", `Sandbox directory already exists and is not empty: ${sandboxPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(sandboxPath, { recursive: false });
  return sandboxPath;
};

export const removeSandboxDirectory = async (sandboxPath: string) => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
};

export const listSandboxDirectories = async () => {
  const runsRoot = resolveRunsRoot();
  await fs.mkdir(runsRoot, { recursive: true });
  const entries = await fs.readdir(runsRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(runsRoot, entry.name));
};
