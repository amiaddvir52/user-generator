import { locateRepository } from "../repo/locator.js";
import { evaluateCompatibility } from "../repo/compatibility.js";
import { computeFingerprint } from "../repo/fingerprint.js";
import type { FingerprintInfo, RepoHandle } from "../common/types.js";
import {
  ensurePlaywrightInstalled,
  ensureWorkingTreeCleanWhenStrict,
  validateRepositoryStructure
} from "../repo/validator.js";
import { runPlaywrightList } from "./playwright-list.js";
import {
  buildValidationCacheKey,
  isValidationCacheHit,
  resolveValidationCacheEnabled,
  resolveValidationCacheTtlMs,
  writeValidationCacheHit
} from "./validation-cache.js";

export type PreflightResult = {
  repo: Awaited<ReturnType<typeof validateRepositoryStructure>>;
  fingerprint: Awaited<ReturnType<typeof computeFingerprint>>;
  compatibility: Awaited<ReturnType<typeof evaluateCompatibility>>;
  playwrightVersion: string;
  warnings: string[];
  repoListCacheHit?: boolean;
};

const fingerprintMemo = new Map<string, Promise<FingerprintInfo>>();

const buildFingerprintMemoKey = (repo: RepoHandle) =>
  repo.isDirty ? undefined : `${repo.absPath}\0${repo.gitSha}`;

export const clearPreflightMemoForTesting = () => {
  fingerprintMemo.clear();
};

const computeFingerprintWithMemo = (repo: RepoHandle) => {
  const memoKey = buildFingerprintMemoKey(repo);
  if (!memoKey) {
    return computeFingerprint(repo);
  }

  const existing = fingerprintMemo.get(memoKey);
  if (existing) {
    return existing;
  }

  const next = computeFingerprint(repo).catch((error) => {
    fingerprintMemo.delete(memoKey);
    throw error;
  });
  fingerprintMemo.set(memoKey, next);
  return next;
};

export const runPreflightGates = async ({
  repoPath,
  strict,
  trustUnknown,
  dryList,
  env
}: {
  repoPath: string;
  strict: boolean;
  trustUnknown: boolean;
  dryList: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<PreflightResult> => {
  const warnings: string[] = [];
  const resolvedRepoPath = await locateRepository(repoPath);
  const repo = await validateRepositoryStructure(resolvedRepoPath);
  const fingerprintPromise = computeFingerprintWithMemo(repo);
  const playwrightVersionPromise = ensurePlaywrightInstalled(repo);
  playwrightVersionPromise.catch(() => undefined);
  const fingerprint = await fingerprintPromise.catch(async (error) => {
    await playwrightVersionPromise.catch(() => undefined);
    throw error;
  });
  const [compatibility, playwrightVersion] = await Promise.all([
    evaluateCompatibility({
      fingerprint,
      trustUnknown
    }),
    playwrightVersionPromise
  ]);

  ensureWorkingTreeCleanWhenStrict(repo, strict);
  if (!strict && repo.isDirty) {
    warnings.push("Working tree is dirty in automation fingerprint inputs.");
  }

  let repoListCacheHit: boolean | undefined;
  if (dryList) {
    const validationCacheEnabled = resolveValidationCacheEnabled(env);
    const cacheTtlMs = resolveValidationCacheTtlMs({ env });
    const canUseCache = validationCacheEnabled && !repo.isDirty;
    const cacheKey = buildValidationCacheKey({
      kind: "repo-list",
      components: {
        fingerprint: fingerprint.fingerprint,
        repoPath: repo.absPath.replace(/\\/g, "/"),
        configPath: repo.playwrightConfigPath.replace(/\\/g, "/"),
        environment: env?.TUG_ENVIRONMENT ?? env?.env ?? null,
        cloudProvider: env?.cloudProvider ?? null,
        region: env?.region ?? null
      }
    });

    const cacheHit = canUseCache
      ? await isValidationCacheHit({
          kind: "repo-list",
          key: cacheKey
        })
      : false;
    repoListCacheHit = cacheHit;

    if (!cacheHit) {
      await runPlaywrightList({
        repo,
        configPath: repo.playwrightConfigPath,
        env
      });

      if (canUseCache) {
        await writeValidationCacheHit({
          kind: "repo-list",
          key: cacheKey,
          ttlMs: cacheTtlMs
        });
      }
    }
  }

  return {
    repo,
    fingerprint,
    compatibility,
    playwrightVersion,
    warnings,
    repoListCacheHit
  };
};
