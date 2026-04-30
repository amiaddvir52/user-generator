import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import type {
  CompatibilityResult,
  IndexData,
  RepoHandle,
  SpecIndexEntry,
  TeardownDetectionResult
} from "../common/types.js";
import { resolveCacheRoot } from "../common/paths.js";

export const INDEX_CACHE_VERSION = 2;

const resolveIndexRoot = () => path.join(resolveCacheRoot(), "indexes");

const hashJson = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const buildCompatibilityHash = (compatibility: CompatibilityResult) =>
  hashJson({
    status: compatibility.status,
    knownTeardownHints: compatibility.knownTeardownHints
  }).slice(0, 16);

export const buildIndexCacheKey = ({
  kind,
  repo,
  fingerprint,
  compatibility,
  sourceFile
}: {
  kind: "full" | "teardown" | "entries";
  repo: RepoHandle;
  fingerprint: string;
  compatibility: CompatibilityResult;
  sourceFile?: string;
}) => {
  if (repo.isDirty) {
    return null;
  }

  const digest = hashJson({
    version: INDEX_CACHE_VERSION,
    kind,
    repoPath: repo.absPath.replace(/\\/g, "/"),
    gitSha: repo.gitSha,
    fingerprint,
    compatibility: buildCompatibilityHash(compatibility),
    sourceFile: sourceFile?.replace(/\\/g, "/") ?? null
  }).slice(0, 20);

  return `${fingerprint}-${kind}-${digest}`;
};

const resolveIndexCachePathByKey = (cacheKey: string) =>
  path.join(resolveIndexRoot(), `${cacheKey}.json`);

export const resolveIndexCachePath = (cacheKey: string) => resolveIndexCachePathByKey(cacheKey);

const loadJsonCache = async <T>(cacheKey: string): Promise<T | null> => {
  const cachePath = resolveIndexCachePathByKey(cacheKey);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const saveJsonCache = async (cacheKey: string, value: unknown) => {
  const cachePath = resolveIndexCachePathByKey(cacheKey);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return cachePath;
};

export const loadIndexCache = async (cacheKey: string): Promise<IndexData | null> =>
  loadJsonCache<IndexData>(cacheKey);

export const saveIndexCache = async (cacheKey: string, index: IndexData) =>
  saveJsonCache(cacheKey, index);

export const loadTeardownCache = async (
  cacheKey: string
): Promise<TeardownDetectionResult | null> => loadJsonCache<TeardownDetectionResult>(cacheKey);

export const saveTeardownCache = async (
  cacheKey: string,
  teardown: TeardownDetectionResult
) => saveJsonCache(cacheKey, teardown);

export const loadSpecEntriesCache = async (
  cacheKey: string
): Promise<SpecIndexEntry[] | null> => loadJsonCache<SpecIndexEntry[]>(cacheKey);

export const saveSpecEntriesCache = async (
  cacheKey: string,
  entries: SpecIndexEntry[]
) => saveJsonCache(cacheKey, entries);
