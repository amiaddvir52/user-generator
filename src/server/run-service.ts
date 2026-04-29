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
import { parseCredentialExecution } from "../tug/execute/output-parser.js";
import { findEntryBySpecAndTitle, getOrBuildIndex, transformIntoSandbox } from "../tug/cli/workflow.js";
import { isTugError, TugError } from "../tug/common/errors.js";
import { enableRcpMockAndWait } from "./rcp-mock.js";
import type {
  ExecutionMode,
  GeneratedAccounts,
  RemovedCallsite,
  RunState,
  RunTiming
} from "../tug/common/types.js";

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
  executionMode?: ExecutionMode;
  allowAutoFallback?: boolean;
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
  executionMode: ExecutionMode;
  fallbackTriggered: boolean;
  confidence: number;
  removedCalls: RemovedCallsite[];
  sandboxPath: string;
  accounts: GeneratedAccounts;
  runState: RunState;
  timing?: RunTiming;
  fastPathTriggered?: boolean;
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
    strict: Boolean(input.strict),
    executionMode: input.executionMode ?? "fast",
    allowAutoFallback: input.allowAutoFallback ?? true
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
  const totalStartedAt = Date.now();
  const context = await loadRunContext({
    environment: input.environment
  });

  ensureRequiredEnvironment({ environment: context.environment });

  const executionEnv = buildExecutionEnv({
    environment: context.environment
  });
  const requestedExecutionMode: ExecutionMode = input.executionMode ?? "fast";
  const allowAutoFallback = input.allowAutoFallback ?? true;

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
  const selectionStartedAt = Date.now();

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
  const selectionMs = Date.now() - selectionStartedAt;

  const executeAttempt = async ({
    executionMode,
    cleanupOnFailure
  }: {
    executionMode: ExecutionMode;
    cleanupOnFailure: boolean;
  }) => {
    const transformStartedAt = Date.now();
    const pipeline = await transformIntoSandbox({
      entry,
      repo: preflight.repo,
      fingerprint: preflight.fingerprint.fingerprint,
      compatibility: preflight.compatibility,
      index,
      interactiveConfirm: Boolean(input.trustUncertainTeardown),
      executionMode,
      env: executionEnv
    });
    const transformMs = Date.now() - transformStartedAt;

    let cleanupAfterSuccess = !input.keepSandbox;
    try {
      const grepPattern = buildPlaywrightGrepPattern(entry);
      const executeStartedAt = Date.now();
      const execution = await runSandboxedTest({
        repo: preflight.repo,
        sandbox: pipeline.sandbox,
        grepPattern,
        env: executionEnv
      });
      const credentialExecution = parseCredentialExecution(execution.markerLines);
      const executeMs = Date.now() - executeStartedAt;

      if (executionMode === "fast" && !credentialExecution.accounts.target?.usable) {
        throw new TugError(
          "CREDENTIAL_MARKER_MISSING",
          "Fast execution mode completed without complete primary credentials (email/password)."
        );
      }

      return {
        executionMode,
        pipeline,
        credentialExecution,
        timing: {
          transformMs,
          executeMs
        }
      };
    } catch (error) {
      if (cleanupOnFailure) {
        cleanupAfterSuccess = true;
      } else {
        cleanupAfterSuccess = false;
      }
      throw error;
    } finally {
      if (cleanupAfterSuccess) {
        await cleanupSandbox(pipeline.sandbox);
      }
    }
  };

  let fallbackTriggered = false;
  let resolvedExecutionMode: ExecutionMode = requestedExecutionMode;
  let fallbackWarning: string | undefined;
  let rcpMockRunUrl: string | undefined;
  type ExecutionAttemptResult = {
    executionMode: ExecutionMode;
    pipeline: Awaited<ReturnType<typeof transformIntoSandbox>>;
    credentialExecution: ReturnType<typeof parseCredentialExecution>;
    timing: {
      transformMs: number;
      executeMs: number;
    };
  };

  try {
    if (input.enableRcpMock) {
      const rcpMockRun = await enableRcpMockAndWait();
      rcpMockRunUrl = rcpMockRun.runUrl;
      tugLog("run.rcpMock.ready", {
        runId: rcpMockRun.runId,
        runUrl: rcpMockRun.runUrl
      });
    }

    let attemptResult: ExecutionAttemptResult;
    if (requestedExecutionMode === "fast") {
      try {
        attemptResult = await executeAttempt({
          executionMode: "fast",
          cleanupOnFailure: allowAutoFallback
        });
      } catch (error) {
        const shouldFallback =
          allowAutoFallback &&
          isTugError(error) &&
          error.reason === "CREDENTIAL_MARKER_MISSING";
        if (!shouldFallback) {
          throw error;
        }

        fallbackTriggered = true;
        resolvedExecutionMode = "full";
        fallbackWarning = "Fast execution mode fallback triggered: reran in full mode for complete credentials.";
        attemptResult = await executeAttempt({
          executionMode: "full",
          cleanupOnFailure: false
        });
      }
    } else {
      attemptResult = await executeAttempt({
        executionMode: "full",
        cleanupOnFailure: false
      });
    }

    const warningLines = [...preflight.warnings];
    if (fallbackWarning) {
      warningLines.push(fallbackWarning);
    }
    if (attemptResult.credentialExecution.warning) {
      warningLines.push(attemptResult.credentialExecution.warning);
    }
    if (!attemptResult.credentialExecution.accounts.target?.usable) {
      warningLines.push("Target account is not fully provisioned or is missing primary credentials.");
    }
    if (rcpMockRunUrl) {
      warningLines.push(`RCP mock workflow run: ${rcpMockRunUrl}`);
    }

    const logFilePath = getLogFilePath();
    const warnings = logFilePath
      ? [...warningLines, `Run log: ${logFilePath}`]
      : warningLines;
    const timing: RunTiming = {
      selectionMs,
      transformMs: attemptResult.timing.transformMs,
      executeMs: attemptResult.timing.executeMs,
      totalMs: Date.now() - totalStartedAt
    };
    const fastPathTriggered =
      resolvedExecutionMode === "fast" &&
      attemptResult.credentialExecution.runState.partial &&
      attemptResult.credentialExecution.runState.exitPhase === "fast-early-return" &&
      Boolean(attemptResult.credentialExecution.accounts.target?.usable);

    tugLog("run.done", {
      fingerprint: preflight.fingerprint.fingerprint,
      sandboxPath: attemptResult.pipeline.sandbox.path,
      filePath: entry.filePath,
      testTitle: entry.testTitle,
      executionMode: resolvedExecutionMode,
      fallbackTriggered,
      fastPathTriggered,
      timing
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
      executionMode: resolvedExecutionMode,
      fallbackTriggered,
      confidence: attemptResult.pipeline.transform.confidence,
      removedCalls: attemptResult.pipeline.transform.removedCalls,
      sandboxPath: attemptResult.pipeline.sandbox.path,
      accounts: attemptResult.credentialExecution.accounts,
      runState: attemptResult.credentialExecution.runState,
      timing,
      fastPathTriggered,
      warnings
    };
  } catch (error) {
    throw error;
  }
};
