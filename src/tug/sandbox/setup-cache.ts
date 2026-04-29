import crypto from "node:crypto";
import path from "node:path";

export const DEFAULT_SETUP_CACHE_TTL_MS = 60 * 60 * 1000;
export const SETUP_CACHE_ENABLED_ENV = "TUG_SETUP_CACHE_ENABLED";
export const SETUP_CACHE_TTL_ENV = "TUG_SETUP_CACHE_TTL_MS";

export const INTERNAL_SETUP_CACHE_FILE_ENV = "TUG_INTERNAL_SETUP_CACHE_FILE";
export const INTERNAL_SETUP_CACHE_TTL_ENV = "TUG_INTERNAL_SETUP_CACHE_TTL_MS";
export const SETUP_CACHE_SNAPSHOT_KEY = "__TUG_SETUP_CACHE_BEFORE_ENV__";

export const SETUP_CACHE_ROUTE_ENV_KEYS = [
  "env",
  "TUG_ENVIRONMENT",
  "cloudProvider",
  "cloudService",
  "marketplace",
  "region"
] as const;

export type SetupCacheRouteEnv = Record<(typeof SETUP_CACHE_ROUTE_ENV_KEYS)[number], string | null>;
export type SetupEnvDelta = Record<string, string | null>;

export type SetupCachePayload = {
  version: 1;
  createdAt: string;
  expiresAt: number;
  envDelta: SetupEnvDelta;
};

export const resolveSetupCacheEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env[SETUP_CACHE_ENABLED_ENV] !== "0";

export const resolveSetupCacheTtlMs = ({
  env = process.env,
  fallbackMs = DEFAULT_SETUP_CACHE_TTL_MS
}: {
  env?: NodeJS.ProcessEnv;
  fallbackMs?: number;
} = {}) => {
  const raw = Number(env[SETUP_CACHE_TTL_ENV]);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallbackMs;
};

export const resolveSetupCacheRouteEnv = (env: NodeJS.ProcessEnv = process.env): SetupCacheRouteEnv =>
  Object.fromEntries(
    SETUP_CACHE_ROUTE_ENV_KEYS.map((key) => [key, env[key] ?? null])
  ) as SetupCacheRouteEnv;

export const buildSetupCacheKey = ({
  fingerprint,
  baseConfigPath,
  globalSetupPaths,
  routeEnv
}: {
  fingerprint: string;
  baseConfigPath: string;
  globalSetupPaths: string[];
  routeEnv: SetupCacheRouteEnv;
}) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        fingerprint,
        baseConfigPath: baseConfigPath.replace(/\\/g, "/"),
        globalSetupPaths: globalSetupPaths.map((value) => value.replace(/\\/g, "/")),
        routeEnv
      })
    )
    .digest("hex");

export const resolveSetupCacheFilePath = ({
  setupCacheRoot,
  cacheKey
}: {
  setupCacheRoot: string;
  cacheKey: string;
}) => path.join(setupCacheRoot, `${cacheKey}.json`);

export const computeSetupEnvDelta = ({
  before,
  after
}: {
  before: NodeJS.ProcessEnv;
  after: NodeJS.ProcessEnv;
}) => {
  const delta: SetupEnvDelta = {};
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);

  keys.forEach((key) => {
    const beforeValue = before[key];
    const afterValue = after[key];

    if (afterValue == null) {
      if (beforeValue != null) {
        delta[key] = null;
      }
      return;
    }

    if (beforeValue !== afterValue) {
      delta[key] = afterValue;
    }
  });

  return delta;
};

export const applySetupEnvDelta = ({
  target,
  delta
}: {
  target: NodeJS.ProcessEnv;
  delta: SetupEnvDelta;
}) => {
  Object.entries(delta).forEach(([key, value]) => {
    if (value === null) {
      delete target[key];
      return;
    }
    target[key] = value;
  });
  return target;
};

export const createSetupCachePayload = ({
  envDelta,
  ttlMs,
  nowMs = Date.now()
}: {
  envDelta: SetupEnvDelta;
  ttlMs: number;
  nowMs?: number;
}): SetupCachePayload => ({
  version: 1,
  createdAt: new Date(nowMs).toISOString(),
  expiresAt: nowMs + ttlMs,
  envDelta
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isSetupEnvDelta = (value: unknown): value is SetupEnvDelta => {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(
    (entry) => typeof entry === "string" || entry === null
  );
};

export const isSetupCachePayload = (value: unknown): value is SetupCachePayload => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.createdAt === "string" &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    isSetupEnvDelta(value.envDelta)
  );
};

export const parseSetupCachePayload = (raw: string): SetupCachePayload | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isSetupCachePayload(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const isSetupCachePayloadFresh = ({
  payload,
  nowMs = Date.now()
}: {
  payload: SetupCachePayload;
  nowMs?: number;
}) => payload.expiresAt > nowMs;
