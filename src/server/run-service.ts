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
import {
  findEntryBySpecAndTitle,
  getOrBuildIndex,
  transformIntoSandbox,
  type SandboxValidationProof
} from "../tug/cli/workflow.js";
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
  executionGate?: <T>(key: string, work: () => Promise<T>) => Promise<T>;
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

  const preflightStartedAt = Date.now();
  const preflight = await runPreflightGates({
    repoPath: context.repoPath,
    strict: Boolean(input.strict),
    trustUnknown: Boolean(input.trustUnknown),
    dryList: false,
    env: executionEnv
  });
  const preflightMs = Date.now() - preflightStartedAt;

  const indexStartedAt = Date.now();
  const { index } = await getOrBuildIndex({
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    forceReindex: Boolean(input.reindex),
    selectionHint: input.spec && input.test
      ? {
          spec: input.spec,
          title: input.test
        }
      : undefined
  });
  const indexMs = Date.now() - indexStartedAt;
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
    cleanupOnFailure,
    validationProof
  }: {
    executionMode: ExecutionMode;
    cleanupOnFailure: boolean;
    validationProof?: SandboxValidationProof;
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
      env: executionEnv,
      validationProof
    });
    const transformMs = Date.now() - transformStartedAt;

    let cleanupAfterSuccess = !input.keepSandbox;
    let attemptSucceeded = false;
    let cleanupMs = 0;
    try {
      const grepPattern = buildPlaywrightGrepPattern(entry);
      await resolveRcpMock();
      const executeStartedAt = Date.now();
      const executionGate = input.executionGate ?? (async <T>(_key: string, work: () => Promise<T>) => work());
      const executionKey = `${preflight.repo.absPath}\0${context.environment ?? ""}`;
      const execution = await executionGate(executionKey, () => runSandboxedTest({
        repo: preflight.repo,
        sandbox: pipeline.sandbox,
        grepPattern,
        env: executionEnv
      }));
      let credentialExecution: ReturnType<typeof parseCredentialExecution>;
      try {
        credentialExecution = parseCredentialExecution(execution.markerLines);
      } catch (error) {
        if (executionMode === "fast" && isTugError(error) && error.reason === "CREDENTIAL_MARKER_MISSING") {
          (error as TugError & { validationProof?: SandboxValidationProof }).validationProof =
            pipeline.validationProof;
        }
        throw error;
      }
      const executeMs = Date.now() - executeStartedAt;

      if (
        executionMode === "fast" &&
        !credentialExecution.accounts.target?.usable &&
        !credentialExecution.runState.completedFullFlow
      ) {
        const error = new TugError(
          "CREDENTIAL_MARKER_MISSING",
          "Fast execution mode completed without complete primary credentials (email/password)."
        );
        (error as TugError & { validationProof?: SandboxValidationProof }).validationProof =
          pipeline.validationProof;
        throw error;
      }

      attemptSucceeded = true;
      return {
        executionMode,
        pipeline,
        credentialExecution,
        timing: {
          transformMs,
          executeMs,
          cleanupMs,
          ...pipeline.timing
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
        const cleanupStartedAt = Date.now();
        if (attemptSucceeded) {
          void cleanupSandbox(pipeline.sandbox).catch(() => undefined);
        } else {
          await cleanupSandbox(pipeline.sandbox);
          cleanupMs = Date.now() - cleanupStartedAt;
        }
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
      cleanupMs?: number;
      sandboxBuildMs?: number;
      sandboxValidationMs?: number;
      sandboxValidationCacheHit?: boolean;
    };
  };

  type RcpMockResult =
    | { ok: true; runId: number; runUrl: string }
    | { ok: false; error: unknown };
  let rcpMockPromise: Promise<RcpMockResult> | undefined;
  const resolveRcpMock = async () => {
    if (!rcpMockPromise || rcpMockRunUrl) {
      return;
    }

    const rcpMockRun = await rcpMockPromise;
    if (!rcpMockRun.ok) {
      throw rcpMockRun.error;
    }
    rcpMockRunUrl = rcpMockRun.runUrl;
    tugLog("run.rcpMock.ready", {
      runId: rcpMockRun.runId,
      runUrl: rcpMockRun.runUrl
    });
  };
  let fallbackMs: number | undefined;

  try {
    if (input.enableRcpMock) {
      rcpMockPromise = enableRcpMockAndWait()
        .then((run): RcpMockResult => ({
          ok: true,
          runId: run.runId,
          runUrl: run.runUrl
        }))
        .catch((error): RcpMockResult => ({
          ok: false,
          error
        }));
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
        const fallbackStartedAt = Date.now();
        attemptResult = await executeAttempt({
          executionMode: "full",
          cleanupOnFailure: false,
          validationProof: (error as TugError & { validationProof?: SandboxValidationProof }).validationProof
        });
        fallbackMs = Date.now() - fallbackStartedAt;
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
      totalMs: Date.now() - totalStartedAt,
      preflightMs,
      indexMs,
      sandboxBuildMs: attemptResult.timing.sandboxBuildMs,
      sandboxValidationMs: attemptResult.timing.sandboxValidationMs,
      cleanupMs: attemptResult.timing.cleanupMs,
      fallbackMs,
      repoListCacheHit: preflight.repoListCacheHit,
      sandboxValidationCacheHit: attemptResult.timing.sandboxValidationCacheHit
    };
    tugLog("run.done", {
      fingerprint: preflight.fingerprint.fingerprint,
      sandboxPath: attemptResult.pipeline.sandbox.path,
      filePath: entry.filePath,
      testTitle: entry.testTitle,
      executionMode: resolvedExecutionMode,
      fallbackTriggered,
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
      warnings
    };
  } catch (error) {
    throw error;
  }
};
