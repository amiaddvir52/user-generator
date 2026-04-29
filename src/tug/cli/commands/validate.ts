import { loadRunContext } from "../../common/context.js";
import { printResult } from "../../common/output.js";
import { buildExecutionEnv } from "../../common/runtime-env.js";
import { runPreflightGates } from "../../validate/gates.js";

export const runValidateCommand = async (options: {
  repo?: string;
  strict?: boolean;
  json?: boolean;
  trustUnknown?: boolean;
}) => {
  const context = await loadRunContext({ repo: options.repo });
  const executionEnv = buildExecutionEnv({
    environment: context.environment
  });
  const preflight = await runPreflightGates({
    repoPath: context.repoPath,
    strict: Boolean(options.strict),
    trustUnknown: Boolean(options.trustUnknown),
    dryList: true,
    env: executionEnv
  });

  const payload = {
    ok: true,
    repo: preflight.repo.absPath,
    gitSha: preflight.repo.gitSha,
    isDirty: preflight.repo.isDirty,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility.status,
    playwrightVersion: preflight.playwrightVersion,
    warnings: preflight.warnings
  };

  printResult({
    json: Boolean(options.json),
    payload,
    text: [
      `Repo: ${preflight.repo.absPath}`,
      `Fingerprint: ${preflight.fingerprint.fingerprint} (${preflight.compatibility.status})`,
      `Git SHA: ${preflight.repo.gitSha}`,
      `Working tree: ${preflight.repo.isDirty ? "dirty" : "clean"}`,
      `Playwright: ${preflight.playwrightVersion}`,
      ...preflight.warnings.map((warning) => `Warning: ${warning}`)
    ].join("\n")
  });
};
