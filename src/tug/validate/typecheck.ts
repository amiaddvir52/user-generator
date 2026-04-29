import type { RepoHandle } from "../common/types.js";
import { TugError } from "../common/errors.js";
import { buildPnpmCommand } from "../common/package-manager.js";
import { runShellCommand } from "../common/shell.js";

const SANDBOX_SPEC_FILENAME = "gen.spec.ts";

const extractSandboxSpecErrors = (output: string) =>
  output
    .split(/\r?\n/)
    .filter((line) => line.includes(`${SANDBOX_SPEC_FILENAME}(`) && line.includes("): error TS"))
    .map((line) => line.trim());

export const runTypecheck = async ({
  repo,
  tsconfigPath
}: {
  repo: RepoHandle;
  tsconfigPath: string;
}) => {
  const result = await runShellCommand({
    command: buildPnpmCommand(repo, ["exec", "tsc", "--noEmit", "-p", tsconfigPath]),
    cwd: repo.smRootPath
  });

  if (result.exitCode === 0) {
    return;
  }

  const combinedOutput = [result.stdout, result.stderr].filter((segment) => segment.length > 0).join("\n");
  const sandboxSpecErrors = extractSandboxSpecErrors(combinedOutput);

  if (sandboxSpecErrors.length === 0) {
    return;
  }

  throw new TugError(
    "VALIDATION_FAILED",
    "TypeScript typecheck failed for transformed sandbox spec.",
    sandboxSpecErrors.slice(0, 5)
  );
};
