import path from "node:path";
import {
  DEFAULT_SETUP_CACHE_TTL_MS,
  INTERNAL_SETUP_CACHE_FILE_ENV,
  INTERNAL_SETUP_CACHE_TTL_ENV,
  SETUP_CACHE_ENABLED_ENV,
  SETUP_CACHE_ROUTE_ENV_KEYS,
  SETUP_CACHE_TTL_ENV
} from "./setup-cache.js";

const isRelativeSpecifier = (value: string) => value.startsWith("./") || value.startsWith("../");

const resolvePathSpecifierAgainstBaseDir = (
  specifier: unknown,
  baseConfigDir: string
): unknown => {
  if (typeof specifier !== "string") {
    return specifier;
  }
  return isRelativeSpecifier(specifier) ? path.resolve(baseConfigDir, specifier) : specifier;
};

export const resolveReportersAgainstBaseDir = (
  reporters: unknown,
  baseConfigDir: string
): unknown => {
  const resolveEntry = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      return resolvePathSpecifierAgainstBaseDir(entry, baseConfigDir);
    }
    if (Array.isArray(entry) && typeof entry[0] === "string" && isRelativeSpecifier(entry[0])) {
      return [path.resolve(baseConfigDir, entry[0]), ...entry.slice(1)];
    }
    return entry;
  };

  if (reporters == null) return reporters;
  if (typeof reporters === "string") {
    return resolvePathSpecifierAgainstBaseDir(reporters, baseConfigDir);
  }
  if (Array.isArray(reporters)) {
    return reporters.map(resolveEntry);
  }
  return reporters;
};

export const generatePlaywrightConfig = ({
  baseConfigPath,
  fingerprint,
  setupCacheRoot,
  setupCacheCaptureScriptPath,
  setupCachePersistScriptPath
}: {
  baseConfigPath: string;
  fingerprint: string;
  setupCacheRoot: string;
  setupCacheCaptureScriptPath: string;
  setupCachePersistScriptPath: string;
}) => {
  const importPath = baseConfigPath.replace(/\\/g, "/");
  const baseConfigDir = path.dirname(baseConfigPath).replace(/\\/g, "/");
  const setupCacheRootPath = setupCacheRoot.replace(/\\/g, "/");
  const captureScriptPath = setupCacheCaptureScriptPath.replace(/\\/g, "/");
  const persistScriptPath = setupCachePersistScriptPath.replace(/\\/g, "/");

  return `import path from 'node:path';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import baseConfig from '${importPath}';
import { defineConfig } from '@playwright/test';

const baseConfigDir = ${JSON.stringify(baseConfigDir)};
const setupCacheRoot = ${JSON.stringify(setupCacheRootPath)};
const tugFingerprint = ${JSON.stringify(fingerprint)};
const setupCacheCaptureScriptPath = ${JSON.stringify(captureScriptPath)};
const setupCachePersistScriptPath = ${JSON.stringify(persistScriptPath)};

const isRelativeSpecifier = (value: string) => value.startsWith('./') || value.startsWith('../');
const setupCacheRouteEnvKeys = ${JSON.stringify(SETUP_CACHE_ROUTE_ENV_KEYS)};

const resolveReporterEntry = (entry: unknown): unknown => {
  if (typeof entry === 'string') {
    return isRelativeSpecifier(entry) ? path.resolve(baseConfigDir, entry) : entry;
  }
  if (Array.isArray(entry) && typeof entry[0] === 'string' && isRelativeSpecifier(entry[0])) {
    return [path.resolve(baseConfigDir, entry[0]), ...entry.slice(1)];
  }
  return entry;
};

const resolveReporters = (reporters: unknown): unknown => {
  if (reporters == null) return reporters;
  if (typeof reporters === 'string') {
    return isRelativeSpecifier(reporters) ? path.resolve(baseConfigDir, reporters) : reporters;
  }
  if (Array.isArray(reporters)) {
    return reporters.map(resolveReporterEntry);
  }
  return reporters;
};

const resolvePathSpecifier = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  return isRelativeSpecifier(value) ? path.resolve(baseConfigDir, value) : value;
};

const resolvePathSpecifiers = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [resolvePathSpecifier(value) as string];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => resolvePathSpecifier(entry) as string);
  }
  return [];
};

const resolveSetupCacheEnabled = () => process.env[${JSON.stringify(SETUP_CACHE_ENABLED_ENV)}] !== '0';
const resolveSetupCacheTtlMs = () => {
  const raw = Number(process.env[${JSON.stringify(SETUP_CACHE_TTL_ENV)}]);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return ${DEFAULT_SETUP_CACHE_TTL_MS};
};

const resolveSetupCacheRouteEnv = () =>
  Object.fromEntries(
    setupCacheRouteEnvKeys.map((key) => [key, process.env[key] ?? null])
  );

const buildSetupCacheKey = (globalSetupPaths: string[]) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        fingerprint: tugFingerprint,
        baseConfigPath: ${JSON.stringify(importPath)},
        globalSetupPaths,
        routeEnv: resolveSetupCacheRouteEnv()
      })
    )
    .digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSetupEnvDelta = (value: unknown): value is Record<string, string | null> =>
  isRecord(value) &&
  Object.values(value).every((entry) => typeof entry === 'string' || entry === null);

const isSetupCachePayload = (
  value: unknown
): value is { version: 1; expiresAt: number; envDelta: Record<string, string | null> } =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.expiresAt === 'number' &&
  Number.isFinite(value.expiresAt) &&
  isSetupEnvDelta(value.envDelta);

const applySetupEnvDelta = (delta: Record<string, string | null>) => {
  Object.entries(delta).forEach(([key, value]) => {
    if (value === null) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  });
};

const baseProjects = (baseConfig as { projects?: Array<Record<string, unknown>> }).projects ?? [];
const preferredBrowserProject =
  baseProjects.find((project) => project.name === 'chromium') ??
  baseProjects.find((project) => Boolean((project as { use?: unknown }).use));
const sandboxUse =
  ((preferredBrowserProject as { use?: Record<string, unknown> } | undefined)?.use) ?? {};

const sandboxProject = {
  name: 'tug-sandbox',
  testDir: __dirname,
  testMatch: ['gen.spec.ts'],
  testIgnore: [] as string[],
  use: sandboxUse
};

const baseGlobalSetupPaths = resolvePathSpecifiers((baseConfig as { globalSetup?: unknown }).globalSetup);
const resolvedGlobalTeardown = resolvePathSpecifiers((baseConfig as { globalTeardown?: unknown }).globalTeardown);

let resolvedGlobalSetup: string[] | undefined = baseGlobalSetupPaths.length > 0 ? baseGlobalSetupPaths : undefined;
if (resolveSetupCacheEnabled() && baseGlobalSetupPaths.length > 0) {
  const setupCacheKey = buildSetupCacheKey(baseGlobalSetupPaths);
  const setupCacheFilePath = path.join(setupCacheRoot, \`\${setupCacheKey}.json\`);
  const setupCacheTtlMs = resolveSetupCacheTtlMs();
  let cachePayload: unknown;
  try {
    const raw = readFileSync(setupCacheFilePath, 'utf8');
    cachePayload = JSON.parse(raw);
  } catch {
    cachePayload = undefined;
  }

  if (isSetupCachePayload(cachePayload) && cachePayload.expiresAt > Date.now()) {
    applySetupEnvDelta(cachePayload.envDelta);
    resolvedGlobalSetup = undefined;
  } else {
    process.env[${JSON.stringify(INTERNAL_SETUP_CACHE_FILE_ENV)}] = setupCacheFilePath;
    process.env[${JSON.stringify(INTERNAL_SETUP_CACHE_TTL_ENV)}] = String(setupCacheTtlMs);
    resolvedGlobalSetup = [
      setupCacheCaptureScriptPath,
      ...baseGlobalSetupPaths,
      setupCachePersistScriptPath
    ];
  }
}

export default defineConfig({
  ...baseConfig,
  reporter: resolveReporters((baseConfig as { reporter?: unknown }).reporter) as never,
  testDir: __dirname,
  testMatch: ['gen.spec.ts'],
  testIgnore: [],
  projects: [sandboxProject],
  globalSetup: resolvedGlobalSetup as never,
  globalTeardown:
    (resolvedGlobalTeardown.length > 0 ? resolvedGlobalTeardown : undefined) as never,
  workers: 1,
  retries: 0
});
`;
};
