import path from "node:path";

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
import { formatRunTimingSummary } from "../../common/timing.js";
import type {
  ExecutionMode,
  Intent,
  RankedCandidate,
  RunDiagnostics,
  RunTiming,
  SpecIndexEntry
} from "../../common/types.js";

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
    compose?: boolean;
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

  const preflightStartedAt = Date.now();
  const preflight = await runPreflightGates({
    repoPath: context.repoPath,
    strict: Boolean(options.strict),
    trustUnknown: Boolean(options.trustUnknown),
    dryList: true,
    env: executionEnv
  });
  const preflightMs = Date.now() - preflightStartedAt;

  const indexStartedAt = Date.now();
  const { index } = await getOrBuildIndex({
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    forceReindex: Boolean(options.reindex)
  });
  const indexMs = Date.now() - indexStartedAt;
  const selectionStartedAt = Date.now();

  let entry: SpecIndexEntry;
  let selectionMeta:
    | {
        ambiguous: boolean;
        margin: number;
        reasons: string[];
      }
    | undefined;
  let composeContext: { intent: Intent; donorCandidates: RankedCandidate[] } | undefined;

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

    const composeEnabled = options.compose !== false;
    const donorCandidates = selection.compositionCandidates;
    const compositionAvailable = composeEnabled && donorCandidates.length > 0;

    if (compositionAvailable && !options.yes) {
      const donorCount = donorCandidates.length;
      const donorWord = donorCount === 1 ? "donor" : "donors";
      const donorSummary = donorCandidates
        .map((candidate) => `${candidate.entry.testTitle} (${path.basename(candidate.entry.filePath)})`)
        .join(", ");
      const choiceIndex = await chooseFromCandidates({
        message: intent.compose
          ? `Prompt mentions multiple actions — no single test fully matches. Compose ${entry.testTitle} + [${donorSummary}]?`
          : `No clear single match (margin ${selection.margin.toFixed(2)}). Compose ${entry.testTitle} + [${donorSummary}]?`,
        options: [
          "Pick a single test from the top candidates",
          `Compose: splice ${entry.testTitle} + ${donorCount} ${donorWord}`,
          "Cancel"
        ]
      });
      if (choiceIndex === 0) {
        const topChoices = selection.ranked.slice(0, 3);
        const selectionIndex = await chooseFromCandidates({
          message: "Pick a single test:",
          options: topChoices.map(
            (candidate) => `${candidate.entry.testTitle} (${candidate.entry.filePath}) score=${candidate.score.toFixed(2)}`
          )
        });
        entry = topChoices[selectionIndex].entry;
      } else if (choiceIndex === 1) {
        composeContext = { intent, donorCandidates };
      } else {
        throw new TugError("USER_CANCELED", "Execution canceled by user.");
      }
    } else if (compositionAvailable && options.yes) {
      const donorCount = donorCandidates.length;
      const donorWord = donorCount === 1 ? "donor" : "donors";
      process.stderr.write(
        `Warning: composing synthetic spec under --yes from base "${entry.testTitle}" + ${donorCount} ${donorWord}.\n`
      );
      composeContext = { intent, donorCandidates };
    } else if (selection.ambiguous && options.yes) {
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
      sandboxBuildMs?: number;
      sandboxValidationMs?: number;
      sandboxValidationCacheHit?: boolean;
      cleanupMs?: number;
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
      env: executionEnv,
      composition: composeContext
    });
    const transformMs = Date.now() - transformStartedAt;

    let cleanupAfterSuccess = !options.keepSandbox;
    const timing: ExecutionAttemptResult["timing"] = {
      transformMs,
      executeMs: 0,
      sandboxBuildMs: pipeline.timing.sandboxBuildMs,
      sandboxValidationMs: pipeline.timing.sandboxValidationMs,
      sandboxValidationCacheHit: pipeline.timing.sandboxValidationCacheHit
    };
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
        const composition = pipeline.transform.composition;
        const compositionLines = composition
          ? [
              `Composition: ${composition.strategy} — no single test fully matched`,
              `  base:  ${entry.testTitle} (${path.basename(composition.baseSourceFile)})`,
              ...composition.donors.map((donor) => `  donor: ${path.basename(donor)}`),
              `  spliced fragments: ${composition.fragmentCount}`,
              ""
            ]
          : [];

        const preview = [
          ...compositionLines,
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
            throw new TugError("USER_CANCELED", "Execution canceled by user.");
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
      timing.executeMs = Date.now() - executeStartedAt;

      const credentialExecution = parseCredentialExecution(execution.markerLines);
      if (
        executionMode === "fast" &&
        !credentialExecution.accounts.target?.usable &&
        !credentialExecution.runState.completedFullFlow
      ) {
        throw new TugError(
          "CREDENTIAL_MARKER_MISSING",
          "Fast execution mode completed without complete primary credentials (email/password)."
        );
      }

      return {
        pipeline,
        credentialExecution,
        executionMode,
        timing
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
        await cleanupSandbox(pipeline.sandbox);
        timing.cleanupMs = Date.now() - cleanupStartedAt;
      }
    }
  };

  let fallbackTriggered = false;
  let fallbackWarning: string | undefined;
  let fallbackMs: number | undefined;
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

      const fallbackStartedAt = Date.now();
      result = await executeAttempt({
        executionMode: "full",
        showPreviewAndPrompt: false,
        cleanupOnFailure: false
      });
      fallbackMs = Date.now() - fallbackStartedAt;
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
    totalMs: Date.now() - totalStartedAt,
    preflightMs,
    indexMs,
    sandboxBuildMs: result.timing.sandboxBuildMs,
    sandboxValidationMs: result.timing.sandboxValidationMs,
    cleanupMs: result.timing.cleanupMs,
    fallbackMs,
    repoListCacheHit: preflight.repoListCacheHit,
    sandboxValidationCacheHit: result.timing.sandboxValidationCacheHit
  };
  const diagnostics: RunDiagnostics = {
    timingSummary: formatRunTimingSummary(timing)
  };

  if (!options.json) {
    process.stderr.write(`${diagnostics.timingSummary}\n`);
  }
  const payload = {
    ok: true,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility.status,
    selectedTest: {
      filePath: entry.filePath,
      title: entry.testTitle
    },
    selection: selectionMeta,
    composition: result.pipeline.transform.composition,
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
    diagnostics,
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
      result.pipeline.transform.composition
        ? `Composed from ${result.pipeline.transform.composition.donors.length} donor(s): ${result.pipeline.transform.composition.donors.join(", ")}`
        : "",
      `Environment: ${context.environment}`,
      `Execution mode: ${result.executionMode}`,
      `Fallback triggered: ${fallbackTriggered ? "yes" : "no"}`,
      `Sandbox: ${result.pipeline.sandbox.path}`,
      `Target account: ${JSON.stringify(result.credentialExecution.accounts.target?.fields ?? {})}`,
      `Run state: ${result.credentialExecution.runState.partial ? "partial" : "complete"}`,
      `Timing(ms): ${JSON.stringify(timing)}`,
      options.output ? `Wrote output to ${options.output}` : ""
    ]
      .filter(Boolean)
      .join("\n")
  });
};
