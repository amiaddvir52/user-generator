import {
  DEFAULT_SETUP_CACHE_TTL_MS,
  INTERNAL_SETUP_CACHE_FILE_ENV,
  INTERNAL_SETUP_CACHE_TTL_ENV,
  SETUP_CACHE_SNAPSHOT_KEY
} from "./setup-cache.js";

export const SETUP_CACHE_CAPTURE_SCRIPT_NAME = "playwright.setup-cache.capture.mjs";
export const SETUP_CACHE_PERSIST_SCRIPT_NAME = "playwright.setup-cache.persist.mjs";

export const generateSetupCacheCaptureScript = () => `const SNAPSHOT_KEY = ${JSON.stringify(SETUP_CACHE_SNAPSHOT_KEY)};

export default async function tugSetupCacheCapture() {
  globalThis[SNAPSHOT_KEY] = { ...process.env };
}
`;

export const generateSetupCachePersistScript = () => `import path from 'node:path';
import { promises as fs } from 'node:fs';

const SNAPSHOT_KEY = ${JSON.stringify(SETUP_CACHE_SNAPSHOT_KEY)};
const CACHE_FILE_ENV = ${JSON.stringify(INTERNAL_SETUP_CACHE_FILE_ENV)};
const CACHE_TTL_ENV = ${JSON.stringify(INTERNAL_SETUP_CACHE_TTL_ENV)};
const DEFAULT_TTL_MS = ${DEFAULT_SETUP_CACHE_TTL_MS};

const computeEnvDelta = (before, after) => {
  const delta = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  keys.forEach((key) => {
    const beforeValue = before?.[key];
    const afterValue = after?.[key];
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

const resolveTtlMs = () => {
  const raw = Number(process.env[CACHE_TTL_ENV]);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_TTL_MS;
};

const buildPayload = (envDelta) => {
  const now = Date.now();
  return {
    version: 1,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + resolveTtlMs(),
    envDelta
  };
};

export default async function tugSetupCachePersist() {
  const cacheFilePath = process.env[CACHE_FILE_ENV];
  if (!cacheFilePath) {
    return;
  }

  const snapshot = globalThis[SNAPSHOT_KEY];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return;
  }

  const envDelta = computeEnvDelta(snapshot, process.env);
  const payload = buildPayload(envDelta);
  const tempPath = \`\${cacheFilePath}.\${process.pid}.\${Date.now()}.tmp\`;

  try {
    await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
    await fs.writeFile(tempPath, \`\${JSON.stringify(payload)}\\n\`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, cacheFilePath);
    await fs.chmod(cacheFilePath, 0o600).catch(() => undefined);
  } catch {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
`;
