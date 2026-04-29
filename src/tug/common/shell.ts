import { spawn } from "node:child_process";

import { tugLog } from "./logger.js";

export type ShellResult = {
  command: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export const quoteForShellValue = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const runShellCommand = async ({
  command,
  cwd,
  env,
  streamPrefix,
  onStdout,
  onStderr
}: {
  command: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  streamPrefix?: string;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}): Promise<ShellResult> => {
  const [binary, ...args] = command;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    tugLog("shell.start", { command, cwd });

    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdoutLines.push(chunk);
      if (streamPrefix) {
        chunk
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .forEach((line) => {
            process.stdout.write(`${streamPrefix}${line}\n`);
            onStdout?.(line);
          });
        return;
      }

      onStdout?.(chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      stderrLines.push(chunk);
      if (streamPrefix) {
        chunk
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .forEach((line) => {
            process.stderr.write(`${streamPrefix}${line}\n`);
            onStderr?.(line);
          });
        return;
      }

      onStderr?.(chunk);
    });

    child.on("error", reject);

    child.on("close", (exitCode) => {
      const stdout = stdoutLines.join("");
      const stderr = stderrLines.join("");
      tugLog("shell.done", {
        command,
        cwd,
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr
      });
      resolve({
        command,
        cwd,
        stdout,
        stderr,
        exitCode: exitCode ?? 1
      });
    });
  });
};
