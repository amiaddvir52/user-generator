import { spawn } from "node:child_process";

import type { RepoHandle } from "./types.js";

const windowsSuffix = process.platform === "win32" ? ".cmd" : "";

const pnpmBinary = `pnpm${windowsSuffix}`;
const corepackBinary = `corepack${windowsSuffix}`;
const npxBinary = `npx${windowsSuffix}`;

const canRun = async (command: string[], cwd: string) => {
  const [binary, ...args] = command;

  return new Promise<boolean>((resolve) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: "ignore"
    });

    child.on("error", () => resolve(false));
    child.on("close", (exitCode) => resolve((exitCode ?? 1) === 0));
  });
};

export const resolvePnpmCommand = async (cwd: string): Promise<string[]> => {
  const configured = process.env.TUG_PNPM_COMMAND?.trim();
  if (configured) {
    return configured.split(/\s+/).filter(Boolean);
  }

  if (await canRun([pnpmBinary, "--version"], cwd)) {
    return [pnpmBinary];
  }

  if (await canRun([corepackBinary, "pnpm", "--version"], cwd)) {
    return [corepackBinary, "pnpm"];
  }

  return [npxBinary, "--yes", "pnpm"];
};

export const buildPnpmCommand = (repo: RepoHandle, args: string[]) => [
  ...(repo.packageManagerCommand ?? [pnpmBinary]),
  ...args
];

const quoteForDisplay = (value: string) => {
  if (!/[\s'"\\$`]/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
};

export const formatCommandForDisplay = (command: string[]) =>
  command.map(quoteForDisplay).join(" ");
