import path from "node:path";
import { promises as fs } from "node:fs";

import { TugError } from "../common/errors.js";

export const locateRepository = async (candidatePath: string) => {
  const absoluteInput = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(process.cwd(), candidatePath);

  let realPath: string;
  try {
    realPath = await fs.realpath(absoluteInput);
  } catch {
    throw new TugError("PATH_INVALID", `Repository path does not exist: ${absoluteInput}`);
  }

  const stats = await fs.stat(realPath).catch(() => undefined);
  if (!stats?.isDirectory()) {
    throw new TugError("PATH_INVALID", `Repository path must be a directory: ${realPath}`);
  }

  await fs.access(path.join(realPath, ".git")).catch(() => {
    throw new TugError("PATH_NOT_GIT_REPO", `Path is not a git repository: ${realPath}`);
  });

  return realPath;
};

