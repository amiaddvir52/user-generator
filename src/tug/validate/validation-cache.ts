import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { resolveCacheRoot } from "../common/paths.js";

export const VALIDATION_CACHE_ENABLED_ENV = "TUG_VALIDATION_CACHE_ENABLED";
export const VALIDATION_CACHE_TTL_ENV = "TUG_VALIDATION_CACHE_TTL_MS";
export const DEFAULT_VALIDATION_CACHE_TTL_MS = 10 * 60 * 1000;

type ValidationCacheKind = "repo-list" | "sandbox-validation";

type ValidationCachePayload = {
  version: 1;
  createdAt: string;
  expiresAt: number;
};

const VALIDATION_CACHE_DIR_NAME = "validation-cache";

const resolveValidationCacheRoot = () => path.join(resolveCacheRoot(), VALIDATION_CACHE_DIR_NAME);

export const resolveValidationCacheEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env[VALIDATION_CACHE_ENABLED_ENV] !== "0";

export const resolveValidationCacheTtlMs = ({
  env = process.env,
  fallbackMs = DEFAULT_VALIDATION_CACHE_TTL_MS
}: {
  env?: NodeJS.ProcessEnv;
  fallbackMs?: number;
} = {}) => {
  const raw = Number(env[VALIDATION_CACHE_TTL_ENV]);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallbackMs;
};

export const buildValidationCacheKey = ({
  kind,
  components
}: {
  kind: ValidationCacheKind;
  components: Record<string, unknown>;
}) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify({ kind, components }))
    .digest("hex");

const resolveValidationCacheFilePath = ({
  kind,
  key
}: {
  kind: ValidationCacheKind;
  key: string;
}) => path.join(resolveValidationCacheRoot(), kind, `${key}.json`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidationCachePayload = (value: unknown): value is ValidationCachePayload =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.createdAt === "string" &&
  typeof value.expiresAt === "number" &&
  Number.isFinite(value.expiresAt);

export const isValidationCacheHit = async ({
  kind,
  key,
  nowMs = Date.now()
}: {
  kind: ValidationCacheKind;
  key: string;
  nowMs?: number;
}) => {
  const cachePath = resolveValidationCacheFilePath({ kind, key });

  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidationCachePayload(parsed)) {
      return false;
    }
    return parsed.expiresAt > nowMs;
  } catch {
    return false;
  }
};

export const writeValidationCacheHit = async ({
  kind,
  key,
  ttlMs,
  nowMs = Date.now()
}: {
  kind: ValidationCacheKind;
  key: string;
  ttlMs: number;
  nowMs?: number;
}) => {
  const cachePath = resolveValidationCacheFilePath({ kind, key });
  const payload: ValidationCachePayload = {
    version: 1,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: nowMs + ttlMs
  };

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return cachePath;
};
