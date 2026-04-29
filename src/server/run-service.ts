import { loadRunContext } from "../tug/common/context.js";
import { ensureLoggerReady, getLogFilePath, tugLog } from "../tug/common/logger.js";
import { buildPlaywrightGrepPattern } from "../tug/common/playwright.js";
import { buildExecutionEnv } from "../tug/common/runtime-env.js";
import { parseIntent } from "../tug/intent/parser.js";
import { selectCandidateDeterministically } from "../tug/selector/deterministic.js";
import { cleanupSandbox } from "../tug/sandbox/builder.js";
import { ensureRequiredEnvironment } from "../tug/validate/env-check.js";
import { runPreflightGates } from "../tug/validate/gates.js";
import { runSandboxedTest } from "../tug/execute/runner.js";
import { parseCredentialMarker } from "../tug/execute/output-parser.js";
import { findEntryBySpecAndTitle, getOrBuildIndex, transformIntoSandbox } from "../tug/cli/workflow.js";
import { isTugError } from "../tug/common/errors.js";
import { enableRcpMockAndWait } from "./rcp-mock.js";
import type { CredentialPayload, RemovedCallsite } from "../tug/common/types.js";

export type UserGenerationInput = {
  prompt?: string;
  spec?: string;
  test?: string;
  environment?: string;
  enableRcpMock?: boolean;
  trustUnknown?: boolean;
  trustUncertainTeardown?: boolean;
  keepSandbox?: boolean;
  reindex?: boolean;
  strict?: boolean;
};

export type UserGenerationPayload = {
  ok: true;
  fingerprint: string;
  compatibility: "supported" | "experimental";
  selectedTest: {
    filePath: string;
    title: string;
  };
  selection?: {
    ambiguous: boolean;
    margin: number;
    reasons: string[];
  };
  environment: string;
  confidence: number;
  removedCalls: RemovedCallsite[];
  sandboxPath: string;
  credentials: CredentialPayload;
  warnings: string[];
};

export const executeUserGeneration = async (
  input: UserGenerationInput
): Promise<UserGenerationPayload> => {
  const logFilePath = await ensureLoggerReady().catch(() => undefined);
  tugLog("run.start", {
    logFilePath,
    prompt: input.prompt,
    spec: input.spec,
    test: input.test,
    environment: input.environment,
    enableRcpMock: Boolean(input.enableRcpMock),
    trustUnknown: Boolean(input.trustUnknown),
    trustUncertainTeardown: Boolean(input.trustUncertainTeardown),
    keepSandbox: Boolean(input.keepSandbox),
    reindex: Boolean(input.reindex),
    strict: Boolean(input.strict)
  });

  try {
    return await runUserGeneration(input);
  } catch (error) {
    const reason = isTugError(error) ? error.reason : "UNKNOWN_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const details = isTugError(error) ? error.details : undefined;
    tugLog("run.failed", { reason, message, details, logFilePath: getLogFilePath() });
    throw error;
  }
};

const runUserGeneration = async (
  input: UserGenerationInput
): Promise<UserGenerationPayload> => {
  const context = await loadRunContext({
    environment: input.environment
  });

  ensureRequiredEnvironment({ environment: context.environment });

  const executionEnv = buildExecutionEnv({
    environment: context.environment
  });

  const preflight = await runPreflightGates({
    repoPath: context.repoPath,
    strict: Boolean(input.strict),
    trustUnknown: Boolean(input.trustUnknown),
    dryList: true,
    env: executionEnv
  });

  const { index } = await getOrBuildIndex({
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    forceReindex: Boolean(input.reindex)
  });

  let entry;
  let selectionMeta: UserGenerationPayload["selection"];

  if (input.spec && input.test) {
    entry = findEntryBySpecAndTitle({
      index,
      spec: input.spec,
      title: input.test
    });
  } else {
    const intent = parseIntent(input.prompt ?? "");
    const selection = selectCandidateDeterministically({
      entries: index.entries,
      intent,
      requireUnambiguous: true
    });

    entry = selection.selected.entry;
    selectionMeta = {
      ambiguous: selection.ambiguous,
      margin: selection.margin,
      reasons: selection.selected.reasons
    };
  }

  const pipeline = await transformIntoSandbox({
    entry,
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    index,
    interactiveConfirm: Boolean(input.trustUncertainTeardown),
    env: executionEnv
  });

  let cleanupAfterSuccess = !input.keepSandbox;
  let rcpMockRunUrl: string | undefined;

  try {
    if (input.enableRcpMock) {
      const rcpMockRun = await enableRcpMockAndWait();
      rcpMockRunUrl = rcpMockRun.runUrl;
      tugLog("run.rcpMock.ready", {
        runId: rcpMockRun.runId,
        runUrl: rcpMockRun.runUrl
      });
    }

    const grepPattern = buildPlaywrightGrepPattern(entry);
    const execution = await runSandboxedTest({
      repo: preflight.repo,
      sandbox: pipeline.sandbox,
      grepPattern,
      env: executionEnv
    });

    const credentials = parseCredentialMarker(execution.markerLines);

    const warningLines = [...preflight.warnings];
    if (rcpMockRunUrl) {
      warningLines.push(`RCP mock workflow run: ${rcpMockRunUrl}`);
    }

    const logFilePath = getLogFilePath();
    const warnings = logFilePath
      ? [...warningLines, `Run log: ${logFilePath}`]
      : warningLines;

    tugLog("run.done", {
      fingerprint: preflight.fingerprint.fingerprint,
      sandboxPath: pipeline.sandbox.path,
      filePath: entry.filePath,
      testTitle: entry.testTitle
    });

    return {
      ok: true,
      fingerprint: preflight.fingerprint.fingerprint,
      compatibility: preflight.compatibility.status,
      selectedTest: {
        filePath: entry.filePath,
        title: entry.testTitle
      },
      selection: selectionMeta,
      environment: context.environment as string,
      confidence: pipeline.transform.confidence,
      removedCalls: pipeline.transform.removedCalls,
      sandboxPath: pipeline.sandbox.path,
      credentials,
      warnings
    };
  } catch (error) {
    cleanupAfterSuccess = false;
    throw error;
  } finally {
    if (cleanupAfterSuccess) {
      await cleanupSandbox(pipeline.sandbox);
    }
  }
};
