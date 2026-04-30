import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { createUnifiedDiff } from "../transform/diff.js";
import { transformSelectedSpec } from "../transform/transformer.js";
import { assertConfidenceThreshold } from "../transform/confidence.js";
import { buildSandbox, cleanupSandbox } from "../sandbox/builder.js";
import { runTypecheck } from "../validate/typecheck.js";
import { runPlaywrightList } from "../validate/playwright-list.js";
import { validateSyntaxRoundTrip } from "../validate/syntax.js";
import {
  buildValidationCacheKey,
  isValidationCacheHit,
  resolveValidationCacheEnabled,
  resolveValidationCacheTtlMs,
  writeValidationCacheHit
} from "../validate/validation-cache.js";
import {
  buildSpecEntriesForFile,
  buildSpecIndex,
  buildTeardownIndex,
  listSpecFiles
} from "../indexer/spec-indexer.js";
import {
  buildIndexCacheKey,
  loadIndexCache,
  loadSpecEntriesCache,
  loadTeardownCache,
  saveIndexCache,
  saveSpecEntriesCache,
  saveTeardownCache
} from "../indexer/cache.js";
import { buildPlaywrightDisplayTitle, buildPlaywrightGrepPattern } from "../common/playwright.js";
import type {
  CompatibilityResult,
  ExecutionMode,
  IndexData,
  RepoHandle,
  SandboxHandle,
  SpecIndexEntry,
  TransformResult
} from "../common/types.js";
import { TugError } from "../common/errors.js";
import { tugLog } from "../common/logger.js";

type IndexSelectionHint = {
  spec: string;
  title: string;
};

type IndexResult = {
  index: IndexData;
  cachePath: string | null;
  loadedFromCache: boolean;
};

type ValidationEnvironmentComponents = {
  environment: string | null;
  cloudProvider: string | null;
  region: string | null;
};

export type SandboxValidationProof = {
  fingerprint: string;
  sourceFile: string;
  sourceTextHash: string;
  testTitle: string;
  expectedTitle: string;
  environment: ValidationEnvironmentComponents;
  coversExecutionModes: ExecutionMode[];
};

const inFlightIndexBuilds = new Map<string, Promise<unknown>>();
const inFlightPartialIndexBuilds = new Map<string, Promise<unknown>>();
const inFlightSandboxValidations = new Map<string, Promise<unknown>>();

const normalizeFilePath = (value: string) => value.replace(/\\/g, "/");

const withInFlight = async <T>(
  map: Map<string, Promise<unknown>>,
  key: string | null,
  work: () => Promise<T>
): Promise<T> => {
  if (!key) {
    return work();
  }

  const existing = map.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const next = work().finally(() => {
    map.delete(key);
  });
  map.set(key, next);
  return next;
};

const canAccessFile = async (filePath: string) => {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
};

const resolveSelectedSpecFile = async ({
  repo,
  spec
}: {
  repo: RepoHandle;
  spec: string;
}) => {
  const normalizedSpec = normalizeFilePath(spec);
  const candidatePaths = path.isAbsolute(normalizedSpec)
    ? [normalizedSpec]
    : [
        path.join(repo.absPath, normalizedSpec),
        path.join(repo.smRootPath, normalizedSpec)
      ];

  for (const candidatePath of candidatePaths) {
    if (await canAccessFile(candidatePath)) {
      return candidatePath;
    }
  }

  const matches = (await listSpecFiles(repo)).filter((filePath) =>
    normalizeFilePath(filePath).endsWith(normalizedSpec)
  );
  return matches.length === 1 ? matches[0] : undefined;
};

export const getOrBuildIndex = async ({
  repo,
  fingerprint,
  compatibility,
  forceReindex,
  selectionHint
}: {
  repo: RepoHandle;
  fingerprint: string;
  compatibility: CompatibilityResult;
  forceReindex: boolean;
  selectionHint?: IndexSelectionHint;
}): Promise<IndexResult> => {
  const buildFullIndex = async (): Promise<IndexResult> => {
    const cacheKey = buildIndexCacheKey({
      kind: "full",
      repo,
      fingerprint,
      compatibility
    });

    if (!forceReindex && cacheKey) {
      const cached = await loadIndexCache(cacheKey);
      if (cached) {
        return {
          index: cached,
          cachePath: null,
          loadedFromCache: true
        };
      }
    }

    return withInFlight(inFlightIndexBuilds, cacheKey, async () => {
      const index = await buildSpecIndex({
        repo,
        fingerprint,
        compatibility
      });

      const cachePath = cacheKey ? await saveIndexCache(cacheKey, index) : null;
      const teardownCacheKey = buildIndexCacheKey({
        kind: "teardown",
        repo,
        fingerprint,
        compatibility
      });
      if (teardownCacheKey) {
        await saveTeardownCache(teardownCacheKey, index.teardown).catch(() => undefined);
      }
      return {
        index,
        cachePath,
        loadedFromCache: false
      };
    });
  };

  const buildDirectIndex = async (): Promise<IndexResult | null> => {
    if (!selectionHint) {
      return null;
    }

    const selectedSpecFile = await resolveSelectedSpecFile({
      repo,
      spec: selectionHint.spec
    });
    if (!selectedSpecFile) {
      return null;
    }

    const teardownCacheKey = buildIndexCacheKey({
      kind: "teardown",
      repo,
      fingerprint,
      compatibility
    });
    const entriesCacheKey = buildIndexCacheKey({
      kind: "entries",
      repo,
      fingerprint,
      compatibility,
      sourceFile: selectedSpecFile
    });

    const loadOrBuildTeardown = async () => {
      if (!forceReindex && teardownCacheKey) {
        const cached = await loadTeardownCache(teardownCacheKey);
        if (cached) {
          return {
            value: cached,
            cachePath: null,
            loadedFromCache: true
          };
        }
      }

      return withInFlight(inFlightPartialIndexBuilds, teardownCacheKey, async () => {
        const teardown = await buildTeardownIndex({
          repo,
          compatibility
        });
        const cachePath = teardownCacheKey
          ? await saveTeardownCache(teardownCacheKey, teardown)
          : null;
        return {
          value: teardown,
          cachePath,
          loadedFromCache: false
        };
      });
    };

    const loadOrBuildEntries = async () => {
      if (!forceReindex && entriesCacheKey) {
        const cached = await loadSpecEntriesCache(entriesCacheKey);
        if (cached) {
          return {
            value: cached,
            cachePath: null,
            loadedFromCache: true
          };
        }
      }

      return withInFlight(inFlightPartialIndexBuilds, entriesCacheKey, async () => {
        const entries = await buildSpecEntriesForFile({
          repo,
          filePath: selectedSpecFile
        });
        const cachePath = entriesCacheKey
          ? await saveSpecEntriesCache(entriesCacheKey, entries)
          : null;
        return {
          value: entries,
          cachePath,
          loadedFromCache: false
        };
      });
    };

    const [teardownResult, entriesResult] = await Promise.all([
      loadOrBuildTeardown(),
      loadOrBuildEntries()
    ]);

    return {
      index: {
        fingerprint,
        generatedAt: new Date().toISOString(),
        entries: entriesResult.value,
        teardown: teardownResult.value
      },
      cachePath: entriesResult.cachePath ?? teardownResult.cachePath,
      loadedFromCache: teardownResult.loadedFromCache && entriesResult.loadedFromCache
    };
  };

  if (!forceReindex) {
    const directIndex = await buildDirectIndex();
    if (directIndex) {
      return directIndex;
    }
  }

  return buildFullIndex();
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

const resolveValidationEnvironment = (
  env?: NodeJS.ProcessEnv
): ValidationEnvironmentComponents => ({
  environment: env?.TUG_ENVIRONMENT ?? env?.env ?? null,
  cloudProvider: env?.cloudProvider ?? null,
  region: env?.region ?? null
});

export const transformIntoSandbox = async ({
  entry,
  repo,
  fingerprint,
  compatibility,
  index,
  interactiveConfirm,
  executionMode = "full",
  env,
  validationProof
}: {
  entry: SpecIndexEntry;
  repo: RepoHandle;
  fingerprint: string;
  compatibility: CompatibilityResult;
  index: IndexData;
  interactiveConfirm: boolean;
  executionMode?: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  validationProof?: SandboxValidationProof;
}) => {
  const transform = await transformSelectedSpec({
    entry,
    teardown: index.teardown,
    compatibilityStatus: compatibility.status,
    workingTreeDirty: repo.isDirty,
    knownFingerprint: compatibility.status === "supported",
    executionMode
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
  let sandboxBuildMs = 0;
  let sandboxValidationMs = 0;
  let sandboxValidationCacheHit = false;
  let resolvedValidationProof: SandboxValidationProof | undefined;

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
    const sandboxBuildStartedAt = Date.now();
    sandbox = await buildSandbox({
      repo,
      fingerprint,
      transform,
      diff,
      runPlan
    });
    sandboxBuildMs = Date.now() - sandboxBuildStartedAt;

    tugLog("sandbox.created", {
      path: sandbox.path,
      specPath: sandbox.specPath,
      playwrightConfigPath: sandbox.playwrightConfigPath,
      tsconfigPath: sandbox.tsconfigPath
    });

    const validationStartedAt = Date.now();
    const validationCacheEnabled = resolveValidationCacheEnabled(env);
    const validationCacheTtlMs = resolveValidationCacheTtlMs({ env });
    const canUseValidationCache = validationCacheEnabled && !repo.isDirty;
    const validationEnvironment = resolveValidationEnvironment(env);
    const transformedSpecHash = crypto
      .createHash("sha256")
      .update(transform.transformedText)
      .digest("hex");
    const sourceTextHash = crypto
      .createHash("sha256")
      .update(transform.originalText)
      .digest("hex");
    const sandboxValidationCacheKey = buildValidationCacheKey({
      kind: "sandbox-validation",
      components: {
        version: 2,
        fingerprint,
        sourceFile: entry.filePath.replace(/\\/g, "/"),
        testTitle: entry.testTitle,
        expectedTitle,
        executionMode,
        transformedSpecHash,
        ...validationEnvironment
      }
    });
    const sandboxValidationExactCacheHit = canUseValidationCache
      ? await isValidationCacheHit({
          kind: "sandbox-validation",
          key: sandboxValidationCacheKey
        })
      : false;
    sandboxValidationCacheHit = sandboxValidationExactCacheHit;

    const proofMatches = Boolean(
      validationProof &&
        validationProof.fingerprint === fingerprint &&
        validationProof.sourceFile === normalizeFilePath(entry.filePath) &&
        validationProof.sourceTextHash === sourceTextHash &&
        validationProof.testTitle === entry.testTitle &&
        validationProof.expectedTitle === expectedTitle &&
        validationProof.coversExecutionModes.includes(executionMode) &&
        JSON.stringify(validationProof.environment) === JSON.stringify(validationEnvironment)
    );

    const validationCoveredByProof = !sandboxValidationCacheHit && proofMatches;

    tugLog("sandbox.validation.cache", {
      filePath: entry.filePath,
      testTitle: entry.testTitle,
      executionMode,
      cacheEnabled: validationCacheEnabled,
      cacheAllowed: canUseValidationCache,
      cacheHit: sandboxValidationCacheHit,
      exactCacheHit: sandboxValidationExactCacheHit,
      proofHit: validationCoveredByProof
    });

    if (!sandboxValidationCacheHit && !validationCoveredByProof) {
      await withInFlight(
        inFlightSandboxValidations,
        canUseValidationCache ? sandboxValidationCacheKey : null,
        async () => {
          const [, listResult] = await Promise.all([
            runTypecheck({
              repo,
              tsconfigPath: sandbox!.tsconfigPath
            }),
            runPlaywrightList({
              repo,
              configPath: sandbox!.playwrightConfigPath,
              expectedTitle,
              env
            })
          ]);

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
        }
      );
    }

    if (
      canUseValidationCache &&
      (!sandboxValidationExactCacheHit || validationCoveredByProof)
    ) {
      await writeValidationCacheHit({
        kind: "sandbox-validation",
        key: sandboxValidationCacheKey,
        ttlMs: validationCacheTtlMs
      });
    }

    sandboxValidationCacheHit = sandboxValidationCacheHit || validationCoveredByProof;
    sandboxValidationMs = Date.now() - validationStartedAt;
    resolvedValidationProof = {
      fingerprint,
      sourceFile: normalizeFilePath(entry.filePath),
      sourceTextHash,
      testTitle: entry.testTitle,
      expectedTitle,
      environment: validationEnvironment,
      coversExecutionModes: [executionMode]
    };
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
    runPlan,
    validationProof: resolvedValidationProof,
    timing: {
      sandboxBuildMs,
      sandboxValidationMs,
      sandboxValidationCacheHit
    }
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
