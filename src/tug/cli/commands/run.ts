import { loadRunContext } from "../../common/context.js";
import { TugError } from "../../common/errors.js";
import { printResult, writeJsonFile } from "../../common/output.js";
import { buildPlaywrightGrepPattern } from "../../common/playwright.js";
import { quoteForShellValue } from "../../common/shell.js";
import { buildExecutionEnv } from "../../common/runtime-env.js";
import { parseIntent } from "../../intent/parser.js";
import { selectCandidateDeterministically } from "../../selector/deterministic.js";
import { cleanupSandbox } from "../../sandbox/builder.js";
import { ensureRequiredEnvironment } from "../../validate/env-check.js";
import { runPreflightGates } from "../../validate/gates.js";
import { runSandboxedTest } from "../../execute/runner.js";
import { parseCredentialMarker } from "../../execute/output-parser.js";
import { chooseFromCandidates, confirmPrompt } from "../prompt.js";
import { findEntryBySpecAndTitle, getOrBuildIndex, renderRemovedCallTable, transformIntoSandbox } from "../workflow.js";

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
  }
) => {
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

  let cleanupAfterSuccess = !options.keepSandbox;
  const pipeline = await transformIntoSandbox({
    entry,
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    index,
    interactiveConfirm: !options.yes,
    env: executionEnv
  });

  try {
    const grepPattern = buildPlaywrightGrepPattern(entry);
    const resolvedCommand = `pnpm --filter ${preflight.repo.packageName} exec playwright test --config ${pipeline.sandbox.playwrightConfigPath} --grep ${JSON.stringify(grepPattern)} --workers=1`;

    const preview = [
      `Selected test: ${entry.testTitle}`,
      `Source: ${entry.filePath}`,
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

    const execution = await runSandboxedTest({
      repo: preflight.repo,
      sandbox: pipeline.sandbox,
      grepPattern,
      env: executionEnv
    });

    const credentials = parseCredentialMarker(execution.markerLines);

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
      provider: context.provider,
      providerBackend: context.providerBackend,
      confidence: pipeline.transform.confidence,
      removedCalls: pipeline.transform.removedCalls,
      sandboxPath: pipeline.sandbox.path,
      credentials,
      warnings: preflight.warnings
    };

    if (options.exportEnv) {
      const envLines = Object.entries(credentials)
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
        `Sandbox: ${pipeline.sandbox.path}`,
        `Credentials: ${JSON.stringify(credentials)}`,
        options.output ? `Wrote output to ${options.output}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    });
  } catch (error) {
    cleanupAfterSuccess = false;
    throw error;
  } finally {
    if (cleanupAfterSuccess) {
      await cleanupSandbox(pipeline.sandbox);
    }
  }
};
