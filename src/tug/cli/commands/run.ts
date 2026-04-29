import { loadRunContext } from "../../common/context.js";
import { TugError } from "../../common/errors.js";
import { printResult, writeJsonFile } from "../../common/output.js";
import { buildPnpmCommand, formatCommandForDisplay } from "../../common/package-manager.js";
import { buildPlaywrightGrepPattern } from "../../common/playwright.js";
import { quoteForShellValue } from "../../common/shell.js";
import { buildExecutionEnv } from "../../common/runtime-env.js";
import { parseIntent } from "../../intent/parser.js";
import { selectCandidateDeterministically } from "../../selector/deterministic.js";
import { cleanupSandbox } from "../../sandbox/builder.js";
import { ensureRequiredEnvironment } from "../../validate/env-check.js";
import { runPreflightGates } from "../../validate/gates.js";
import { runSandboxedTest } from "../../execute/runner.js";
import { parseCredentialExecution } from "../../execute/output-parser.js";
import { chooseFromCandidates, confirmPrompt } from "../prompt.js";
import { findEntryBySpecAndTitle, getOrBuildIndex, renderRemovedCallTable, transformIntoSandbox } from "../workflow.js";
import type { ExecutionMode, RunTiming } from "../../common/types.js";

export const runRunCommand = async (
  prompt: string | undefined,
  options: {
    repo?: string;
    spec?: string;
    test?: string;
    yes?: boolean;
    keepSandbox?: boolean;
    strict?: boolean;
    trustUnknown?: boolean;
    reindex?: boolean;
    output?: string;
    exportEnv?: boolean;
    json?: boolean;
    environment?: string;
    executionMode?: ExecutionMode;
    autoFallback?: boolean;
  }
) => {
  const totalStartedAt = Date.now();
  const context = await loadRunContext({
    repo: options.repo,
    environment: options.environment
  });

  ensureRequiredEnvironment({
    environment: context.environment
  });

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
  const selectionStartedAt = Date.now();

  let entry;
  let selectionMeta:
    | {
        ambiguous: boolean;
        margin: number;
        reasons: string[];
      }
    | undefined;

  if (options.spec && options.test) {
    entry = findEntryBySpecAndTitle({
      index,
      spec: options.spec,
      title: options.test
    });
  } else {
    if (!prompt) {
      throw new TugError(
        "CONFIG_INCOMPLETE",
        "Run requires either a natural-language prompt argument or --spec and --test."
      );
    }

    const intent = parseIntent(prompt);
    const selection = selectCandidateDeterministically({
      entries: index.entries,
      intent,
      requireUnambiguous: false
    });

    entry = selection.selected.entry;
    selectionMeta = {
      ambiguous: selection.ambiguous,
      margin: selection.margin,
      reasons: selection.selected.reasons
    };

    if (selection.ambiguous && !options.yes) {
      const topChoices = selection.ranked.slice(0, 3);
      const selectionIndex = await chooseFromCandidates({
        message: "Multiple close candidates matched your prompt:",
        options: topChoices.map(
          (candidate) => `${candidate.entry.testTitle} (${candidate.entry.filePath}) score=${candidate.score.toFixed(2)}`
        )
      });
      entry = topChoices[selectionIndex].entry;
    }

    if (selection.ambiguous && options.yes) {
      process.stderr.write(
        "Warning: ambiguous candidate selection under --yes, defaulting to top-ranked test.\n"
      );
    }
  }
  const selectionMs = Date.now() - selectionStartedAt;

  const executionModeOption = options.executionMode?.trim().toLowerCase();
  if (
    executionModeOption &&
    executionModeOption !== "full" &&
    executionModeOption !== "fast"
  ) {
    throw new TugError(
      "CONFIG_INCOMPLETE",
      "--execution-mode must be either \"full\" or \"fast\"."
    );
  }

  const requestedExecutionMode: ExecutionMode = (executionModeOption as ExecutionMode | undefined) ?? "full";
  const allowAutoFallback = options.autoFallback ?? true;
  type ExecutionAttemptResult = {
    pipeline: Awaited<ReturnType<typeof transformIntoSandbox>>;
    credentialExecution: ReturnType<typeof parseCredentialExecution>;
    executionMode: ExecutionMode;
    timing: {
      transformMs: number;
      executeMs: number;
    };
  };

  const executeAttempt = async ({
    executionMode,
    showPreviewAndPrompt,
    cleanupOnFailure
  }: {
    executionMode: ExecutionMode;
    showPreviewAndPrompt: boolean;
    cleanupOnFailure: boolean;
  }) => {
    const transformStartedAt = Date.now();
    const pipeline = await transformIntoSandbox({
      entry,
      repo: preflight.repo,
      fingerprint: preflight.fingerprint.fingerprint,
      compatibility: preflight.compatibility,
      index,
      interactiveConfirm: !options.yes,
      executionMode,
      env: executionEnv
    });
    const transformMs = Date.now() - transformStartedAt;

    let cleanupAfterSuccess = !options.keepSandbox;
    try {
      const grepPattern = buildPlaywrightGrepPattern(entry);
      const resolvedCommand = formatCommandForDisplay(
        buildPnpmCommand(preflight.repo, [
          "--filter",
          preflight.repo.packageName,
          "exec",
          "playwright",
          "test",
          "--config",
          pipeline.sandbox.playwrightConfigPath,
          "--grep",
          grepPattern,
          "--workers=1"
        ])
      );

      if (showPreviewAndPrompt) {
        const preview = [
          `Selected test: ${entry.testTitle}`,
          `Source: ${entry.filePath}`,
          `Execution mode: ${executionMode}`,
          `Confidence: ${pipeline.transform.confidence.toFixed(2)}`,
          renderRemovedCallTable(pipeline.transform),
          "",
          "Resolved command:",
          resolvedCommand
        ].join("\n");

        if (!options.json) {
          process.stdout.write(`${preview}\n\n`);
          process.stdout.write(`${pipeline.diff}\n`);
        }

        if (!options.yes) {
          const confirmed = await confirmPrompt({
            message: "Proceed with execution?",
            defaultNo: true
          });
          if (!confirmed) {
            throw new TugError("EXECUTION_FAILED", "Execution canceled by user.");
          }
        }
      }

      const executeStartedAt = Date.now();
      const execution = await runSandboxedTest({
        repo: preflight.repo,
        sandbox: pipeline.sandbox,
        grepPattern,
        env: executionEnv
      });
      const executeMs = Date.now() - executeStartedAt;

      const credentialExecution = parseCredentialExecution(execution.markerLines);
      if (executionMode === "fast" && !credentialExecution.accounts.target?.usable) {
        throw new TugError(
          "CREDENTIAL_MARKER_MISSING",
          "Fast execution mode completed without complete primary credentials (email/password)."
        );
      }

      return {
        pipeline,
        credentialExecution,
        executionMode,
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
  let fallbackWarning: string | undefined;
  let result: ExecutionAttemptResult;

  if (requestedExecutionMode === "fast") {
    try {
      result = await executeAttempt({
        executionMode: "fast",
        showPreviewAndPrompt: true,
        cleanupOnFailure: allowAutoFallback
      });
    } catch (error) {
      const shouldFallback =
        allowAutoFallback &&
        error instanceof TugError &&
        error.reason === "CREDENTIAL_MARKER_MISSING";
      if (!shouldFallback) {
        throw error;
      }

      fallbackTriggered = true;
      fallbackWarning = "Fast execution mode fallback triggered: reran in full mode for complete credentials.";
      if (!options.json) {
        process.stderr.write(`${fallbackWarning}\n`);
      }

      result = await executeAttempt({
        executionMode: "full",
        showPreviewAndPrompt: false,
        cleanupOnFailure: false
      });
    }
  } else {
    result = await executeAttempt({
      executionMode: "full",
      showPreviewAndPrompt: true,
      cleanupOnFailure: false
    });
  }

  const warnings = [...preflight.warnings];
  if (fallbackWarning) {
    warnings.push(fallbackWarning);
  }
  if (result.credentialExecution.warning) {
    warnings.push(result.credentialExecution.warning);
  }
  if (!result.credentialExecution.accounts.target?.usable) {
    warnings.push("Target account is not fully provisioned or is missing primary credentials.");
  }
  const timing: RunTiming = {
    selectionMs,
    transformMs: result.timing.transformMs,
    executeMs: result.timing.executeMs,
    totalMs: Date.now() - totalStartedAt
  };
  const fastPathTriggered =
    result.executionMode === "fast" &&
    result.credentialExecution.runState.partial &&
    result.credentialExecution.runState.exitPhase === "fast-early-return" &&
    Boolean(result.credentialExecution.accounts.target?.usable);

  const payload = {
    ok: true,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility.status,
    selectedTest: {
      filePath: entry.filePath,
      title: entry.testTitle
    },
    selection: selectionMeta,
    environment: context.environment,
    executionMode: result.executionMode,
    fallbackTriggered,
    provider: context.provider,
    providerBackend: context.providerBackend,
    confidence: result.pipeline.transform.confidence,
    removedCalls: result.pipeline.transform.removedCalls,
    sandboxPath: result.pipeline.sandbox.path,
    accounts: result.credentialExecution.accounts,
    runState: result.credentialExecution.runState,
    timing,
    fastPathTriggered,
    warnings
  };

  if (options.exportEnv) {
    const exportWarning =
      !result.credentialExecution.accounts.target?.usable
        ? "Target account is not fully provisioned; skipping export-env output."
        : undefined;
    if (exportWarning) {
      warnings.push(exportWarning);
    }

    const envSource = exportWarning ? {} : result.credentialExecution.accounts.target?.fields ?? {};
    const envLines = Object.entries(envSource)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
      .map(
        ([key, value]) =>
          `export TUG_${key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}=${quoteForShellValue(value)}`
      );

    if (!options.json && envLines.length > 0) {
      process.stdout.write(`${envLines.join("\n")}\n`);
    }

    (payload as Record<string, unknown>).exportEnv = envLines;
  }

  if (options.output) {
    await writeJsonFile(options.output, payload);
  }

  printResult({
    json: Boolean(options.json),
    payload,
    text: [
      `Execution succeeded for ${entry.testTitle}`,
      `Environment: ${context.environment}`,
      `Execution mode: ${result.executionMode}`,
      `Fallback triggered: ${fallbackTriggered ? "yes" : "no"}`,
      `Sandbox: ${result.pipeline.sandbox.path}`,
      `Target account: ${JSON.stringify(result.credentialExecution.accounts.target?.fields ?? {})}`,
      `Run state: ${result.credentialExecution.runState.partial ? "partial" : "complete"}`,
      `Fast path: ${fastPathTriggered ? "yes" : "no"}`,
      `Timing(ms): ${JSON.stringify(timing)}`,
      options.output ? `Wrote output to ${options.output}` : ""
    ]
      .filter(Boolean)
      .join("\n")
  });
};
