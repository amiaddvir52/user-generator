import { spawn } from "node:child_process";

import type { RepoHandle, SandboxHandle } from "../common/types.js";
import { TugError } from "../common/errors.js";
import { extractMissingBareModule, formatMissingModuleDetails } from "../common/missing-module.js";
import { buildPnpmCommand, formatCommandForDisplay } from "../common/package-manager.js";
import { CREDENTIAL_MARKER } from "../transform/credential-probe.js";
import { appendLog, flushBufferedLines, readBufferedLines } from "./stdio.js";

export type ExecutionResult = {
  command: string[];
  markerLines: string[];
  stdout: string;
  stderr: string;
};

export const runSandboxedTest = async ({
  repo,
  sandbox,
  grepPattern,
  env
}: {
  repo: RepoHandle;
  sandbox: SandboxHandle;
  grepPattern: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ExecutionResult> => {
  const command = buildPnpmCommand(repo, [
    "--filter",
    repo.packageName,
    "exec",
    "playwright",
    "test",
    "--config",
    sandbox.playwrightConfigPath,
    "--grep",
    grepPattern,
    "--workers=1"
  ]);

  const [, ...args] = command;

  return new Promise((resolve, reject) => {
    const child = spawn(command[0], args, {
      cwd: repo.absPath,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const markerLines: string[] = [];
    let stdoutRemainder = "";
    let stderrRemainder = "";

    child.stdout.on("data", (chunk: string) => {
      stdoutChunks.push(chunk);
      void appendLog(sandbox.stdoutLogPath, chunk);

      const parsed = readBufferedLines({
        chunk,
        remainder: stdoutRemainder
      });
      stdoutRemainder = parsed.remainder;

      parsed.lines.forEach((line) => {
        if (line.includes(CREDENTIAL_MARKER)) {
          markerLines.push(line);
          return;
        }

        process.stdout.write(`[playwright] ${line}\n`);
      });
    });

    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
      void appendLog(sandbox.stderrLogPath, chunk);

      const parsed = readBufferedLines({
        chunk,
        remainder: stderrRemainder
      });
      stderrRemainder = parsed.remainder;

      parsed.lines.forEach((line) => {
        process.stderr.write(`[playwright] ${line}\n`);
      });
    });

    child.on("error", (error) => {
      reject(new TugError("EXECUTION_FAILED", `Failed to start Playwright: ${error.message}`));
    });

    child.on("close", (exitCode) => {
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      const trailingStdoutLines = flushBufferedLines(stdoutRemainder);
      const trailingStderrLines = flushBufferedLines(stderrRemainder);

      trailingStdoutLines.forEach((line) => {
        if (line.includes(CREDENTIAL_MARKER)) {
          markerLines.push(line);
          return;
        }

        process.stdout.write(`[playwright] ${line}\n`);
      });

      trailingStderrLines.forEach((line) => {
        process.stderr.write(`[playwright] ${line}\n`);
      });

      if ((exitCode ?? 1) !== 0) {
        const missingModule = extractMissingBareModule([stderr, stdout].join("\n"));
        if (missingModule) {
          reject(
            new TugError(
              "EXECUTION_FAILED",
              `Playwright execution failed because automation dependency "${missingModule.moduleName}" is missing.`,
              formatMissingModuleDetails({
                diagnostic: missingModule,
                repoPath: repo.absPath,
                installCommand: formatCommandForDisplay(
                  buildPnpmCommand(repo, ["install", "--frozen-lockfile"])
                ),
                installWasRetried: false
              })
            )
          );
          return;
        }

        reject(
          new TugError(
            "EXECUTION_FAILED",
            `Playwright exited with code ${exitCode ?? 1}.`,
            [stderr.trim() || stdout.trim()]
          )
        );
        return;
      }

      resolve({
        command,
        markerLines,
        stdout,
        stderr
      });
    });
  });
};
