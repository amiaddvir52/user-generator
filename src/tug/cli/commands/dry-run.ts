import { cleanupSandbox } from "../../sandbox/builder.js";
import { loadRunContext } from "../../common/context.js";
import { printResult } from "../../common/output.js";
import { buildPlaywrightGrepPattern } from "../../common/playwright.js";
import { buildExecutionEnv } from "../../common/runtime-env.js";
import { runPreflightGates } from "../../validate/gates.js";
import { findEntryBySpecAndTitle, getOrBuildIndex, renderRemovedCallTable, transformIntoSandbox } from "../workflow.js";

export const runDryRunCommand = async (options: {
  repo?: string;
  spec: string;
  test: string;
  yes?: boolean;
  keepSandbox?: boolean;
  strict?: boolean;
  trustUnknown?: boolean;
  reindex?: boolean;
  json?: boolean;
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

  const { index } = await getOrBuildIndex({
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    forceReindex: Boolean(options.reindex)
  });

  const entry = findEntryBySpecAndTitle({
    index,
    spec: options.spec,
    title: options.test
  });

  const pipeline = await transformIntoSandbox({
    entry,
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    index,
    interactiveConfirm: !options.yes,
    env: executionEnv
  });

  const grepPattern = buildPlaywrightGrepPattern(entry);

  const payload = {
    ok: true,
    mode: "dry-run",
    fingerprint: preflight.fingerprint.fingerprint,
    sourceFile: entry.filePath,
    testTitle: entry.testTitle,
    confidence: pipeline.transform.confidence,
    removedCalls: pipeline.transform.removedCalls,
    sandboxPath: pipeline.sandbox.path,
    playwrightCommand: `pnpm --filter ${preflight.repo.packageName} exec playwright test --config ${pipeline.sandbox.playwrightConfigPath} --grep ${JSON.stringify(grepPattern)} --workers=1`,
    diff: pipeline.diff
  };

  const text = [
    `Dry-run for ${entry.testTitle}`,
    `Sandbox: ${pipeline.sandbox.path}`,
    `Confidence: ${pipeline.transform.confidence.toFixed(2)}`,
    renderRemovedCallTable(pipeline.transform),
    "",
    "Diff:",
    pipeline.diff,
    "",
    `Command: ${payload.playwrightCommand}`
  ].join("\n");

  printResult({
    json: Boolean(options.json),
    payload,
    text
  });

  if (!options.keepSandbox) {
    await cleanupSandbox(pipeline.sandbox);
  }
};
