import path from "node:path";
import { promises as fs } from "node:fs";

import type { RepoHandle } from "../common/types.js";
import { TugError } from "../common/errors.js";
import { tugLog } from "../common/logger.js";
import { buildPnpmCommand } from "../common/package-manager.js";
import { runShellCommand, type ShellResult } from "../common/shell.js";

export type PlaywrightListResult = {
  rawOutput: string;
  tests: string[];
};

const parseListedTests = (stdout: string) => {
  const tests: string[] = [];
  stdout.split(/\r?\n/).forEach((line) => {
    const match = line.match(/›\s(.+)$/);
    if (match) {
      const maybeTitle = match[1].trim();
      if (maybeTitle.length > 0) {
        tests.push(maybeTitle);
      }
    }
  });

  return tests;
};

const buildListCommand = (repo: RepoHandle, configPath?: string) => {
  const command = buildPnpmCommand(repo, ["--filter", repo.packageName, "exec", "playwright", "test"]);
  if (configPath) command.push("--config", configPath);
  command.push("--list");
  return command;
};

const safeReadFile = async (filePath: string) => {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    return `<read failed: ${(error as Error).message}>`;
  }
};

const dumpSandboxArtifacts = async (configPath: string) => {
  const sandboxDir = path.dirname(configPath);
  const specPath = path.join(sandboxDir, "gen.spec.ts");
  const tsconfigPath = path.join(sandboxDir, "tsconfig.gen.json");
  const [configContents, specContents, tsconfigContents] = await Promise.all([
    safeReadFile(configPath),
    safeReadFile(specPath),
    safeReadFile(tsconfigPath)
  ]);
  tugLog("playwright.list.sandbox", {
    sandboxDir,
    configPath,
    specPath,
    tsconfigPath,
    configContents,
    specContents,
    tsconfigContents
  });
};

const runOneList = async (
  repo: RepoHandle,
  configPath: string | undefined,
  phase: string,
  env?: NodeJS.ProcessEnv
) => {
  const command = buildListCommand(repo, configPath);
  tugLog("playwright.list.start", { phase, command, cwd: repo.absPath, configPath });
  const result = await runShellCommand({ command, cwd: repo.absPath, env });
  const tests = parseListedTests(result.stdout);
  tugLog("playwright.list.done", {
    phase,
    exitCode: result.exitCode,
    testCount: tests.length,
    tests
  });
  return { command, result, tests };
};

const failWith = (
  message: string,
  details: string[],
  payload: { phase: string; command: string[]; result: ShellResult; tests: string[]; configPath?: string; expectedTitle?: string }
): never => {
  tugLog("playwright.list.failed", {
    phase: payload.phase,
    exitCode: payload.result.exitCode,
    configPath: payload.configPath,
    expectedTitle: payload.expectedTitle,
    command: payload.command,
    tests: payload.tests,
    stdout: payload.result.stdout,
    stderr: payload.result.stderr
  });
  throw new TugError("VALIDATION_FAILED", message, details);
};

const matchesExpectedTitle = (parsed: string, expectedTitle: string) =>
  parsed === expectedTitle || parsed.endsWith(` › ${expectedTitle}`);

export const runPlaywrightList = async ({
  repo,
  configPath,
  expectedTitle,
  env
}: {
  repo: RepoHandle;
  configPath?: string;
  expectedTitle?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PlaywrightListResult> => {
  if (configPath) {
    await dumpSandboxArtifacts(configPath);
  }

  const { command, result, tests } = await runOneList(repo, configPath, "list", env);
  if (result.exitCode !== 0) {
    failWith(
      "Playwright --list preflight failed.",
      [result.stderr.trim() || result.stdout.trim() || command.join(" ")],
      { phase: "list", command, result, tests, configPath, expectedTitle }
    );
  }

  if (!expectedTitle) {
    return { rawOutput: result.stdout, tests };
  }

  if (tests.length === 0) {
    failWith(
      "Playwright --list preflight failed: sandbox has no discoverable tests (config/spec issue).",
      [
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Playwright reported 0 tests for the sandbox config."
      ],
      { phase: "list", command, result, tests, configPath, expectedTitle }
    );
  }

  const matched = tests.filter((title) => matchesExpectedTitle(title, expectedTitle));

  if (matched.length === 0) {
    failWith(
      "Playwright --list preflight failed: expected test was not discoverable.",
      [
        `expected display title: ${expectedTitle}`,
        `discoverable tests (${tests.length}):`,
        ...tests.slice(0, 10).map((title) => `  - ${title}`)
      ],
      { phase: "list", command, result, tests, configPath, expectedTitle }
    );
  }

  return { rawOutput: result.stdout, tests: matched };
};

export const buildSandboxConfigPath = (sandboxPath: string) =>
  path.join(sandboxPath, "playwright.gen.config.ts");
