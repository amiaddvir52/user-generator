import { createUnifiedDiff } from "../transform/diff.js";
import { transformSelectedSpec } from "../transform/transformer.js";
import { assertConfidenceThreshold } from "../transform/confidence.js";
import { buildSandbox, cleanupSandbox } from "../sandbox/builder.js";
import { runTypecheck } from "../validate/typecheck.js";
import { runPlaywrightList } from "../validate/playwright-list.js";
import { validateSyntaxRoundTrip } from "../validate/syntax.js";
import { buildSpecIndex } from "../indexer/spec-indexer.js";
import { loadIndexCache, saveIndexCache } from "../indexer/cache.js";
import { buildPlaywrightDisplayTitle, buildPlaywrightGrepPattern } from "../common/playwright.js";
import type {
  CompatibilityResult,
  IndexData,
  RepoHandle,
  SandboxHandle,
  SpecIndexEntry,
  TransformResult
} from "../common/types.js";
import { TugError } from "../common/errors.js";
import { tugLog } from "../common/logger.js";

export const getOrBuildIndex = async ({
  repo,
  fingerprint,
  compatibility,
  forceReindex
}: {
  repo: RepoHandle;
  fingerprint: string;
  compatibility: CompatibilityResult;
  forceReindex: boolean;
}): Promise<{ index: IndexData; cachePath: string | null; loadedFromCache: boolean }> => {
  if (!forceReindex) {
    const cached = await loadIndexCache(fingerprint);
    if (cached) {
      return {
        index: cached,
        cachePath: null,
        loadedFromCache: true
      };
    }
  }

  const index = await buildSpecIndex({
    repo,
    fingerprint,
    compatibility
  });

  const cachePath = await saveIndexCache(index);
  return {
    index,
    cachePath,
    loadedFromCache: false
  };
};

export const findEntryBySpecAndTitle = ({
  index,
  spec,
  title
}: {
  index: IndexData;
  spec: string;
  title: string;
}) => {
  const normalizedSpec = spec.replace(/\\/g, "/");
  const matches = index.entries.filter(
    (entry) =>
      entry.testTitle === title &&
      (entry.filePath.replace(/\\/g, "/") === normalizedSpec ||
        entry.filePath.replace(/\\/g, "/").endsWith(normalizedSpec))
  );

  if (matches.length !== 1) {
    throw new TugError(
      "VALIDATION_FAILED",
      `Expected exactly one test match for --spec and --test, found ${matches.length}.`,
      matches.map((match) => `${match.filePath} :: ${match.testTitle}`)
    );
  }

  return matches[0];
};

export const transformIntoSandbox = async ({
  entry,
  repo,
  fingerprint,
  compatibility,
  index,
  interactiveConfirm,
  env
}: {
  entry: SpecIndexEntry;
  repo: RepoHandle;
  fingerprint: string;
  compatibility: CompatibilityResult;
  index: IndexData;
  interactiveConfirm: boolean;
  env?: NodeJS.ProcessEnv;
}) => {
  const transform = await transformSelectedSpec({
    entry,
    teardown: index.teardown,
    compatibilityStatus: compatibility.status,
    workingTreeDirty: repo.isDirty,
    knownFingerprint: compatibility.status === "supported"
  });

  if (transform.uncertainIdentifiers.length > 0) {
    if (!interactiveConfirm) {
      throw new TugError(
        "TEARDOWN_IDENTITY_UNSURE",
        "Transform encountered suspected teardown identifiers that require confirmation.",
        transform.uncertainIdentifiers
      );
    }
  }

  const confidenceResult = assertConfidenceThreshold({
    confidence: transform.confidence,
    interactive: interactiveConfirm
  });

  if (!confidenceResult.ok) {
    throw new TugError(
      "TEARDOWN_IDENTITY_UNSURE",
      `Transform confidence ${transform.confidence.toFixed(2)} is below required threshold.`
    );
  }

  const diff = createUnifiedDiff({
    originalText: transform.originalText,
    transformedText: transform.transformedText,
    originalLabel: entry.filePath,
    transformedLabel: "gen.spec.ts"
  });

  validateSyntaxRoundTrip(transform.transformedText, entry.filePath);

  const runPlan = {
    generatedAt: new Date().toISOString(),
    fingerprint,
    compatibility: compatibility.status,
    sourceFile: entry.filePath,
    testTitle: entry.testTitle,
    removedCalls: transform.removedCalls,
    confidence: transform.confidence,
    gitSha: repo.gitSha,
    dirty: repo.isDirty
  };

  let sandbox: SandboxHandle | undefined;

  const grepPattern = buildPlaywrightGrepPattern(entry);
  const expectedTitle = buildPlaywrightDisplayTitle(entry);
  tugLog("transform.entry", {
    filePath: entry.filePath,
    testTitle: entry.testTitle,
    describeTitles: entry.describeTitles,
    grepPattern,
    expectedTitle,
    confidence: transform.confidence,
    removedCallCount: transform.removedCalls.length
  });

  try {
    sandbox = await buildSandbox({
      repo,
      fingerprint,
      transform,
      diff,
      runPlan
    });

    tugLog("sandbox.created", {
      path: sandbox.path,
      specPath: sandbox.specPath,
      playwrightConfigPath: sandbox.playwrightConfigPath,
      tsconfigPath: sandbox.tsconfigPath
    });

    await runTypecheck({
      repo,
      tsconfigPath: sandbox.tsconfigPath
    });

    const listResult = await runPlaywrightList({
      repo,
      configPath: sandbox.playwrightConfigPath,
      expectedTitle,
      env
    });

    if (listResult.tests.length !== 1) {
      tugLog("sandbox.list.unexpected", {
        expectedTitle,
        testCount: listResult.tests.length,
        tests: listResult.tests
      });
      throw new TugError(
        "VALIDATION_FAILED",
        `Sandbox Playwright list expected 1 test for "${expectedTitle}", got ${listResult.tests.length}.`,
        listResult.tests
      );
    }
  } catch (error) {
    if (sandbox) {
      await cleanupSandbox(sandbox).catch(() => undefined);
    }
    throw error;
  }

  return {
    transform,
    sandbox,
    diff,
    runPlan
  };
};

export const renderRemovedCallTable = (transform: TransformResult) => {
  if (transform.removedCalls.length === 0) {
    return "No teardown calls were removed.";
  }

  const lines = ["Removed call-sites:"];
  transform.removedCalls.forEach((call) => {
    lines.push(
      `- line ${call.line}: ${call.identifier} (${call.kind}, score ${call.score.toFixed(2)})`
    );
  });
  return lines.join("\n");
};
