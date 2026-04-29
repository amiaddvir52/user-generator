import { locateRepository } from "../repo/locator.js";
import { evaluateCompatibility } from "../repo/compatibility.js";
import { computeFingerprint } from "../repo/fingerprint.js";
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
  const fingerprint = await computeFingerprint(repo);
  const compatibility = await evaluateCompatibility({
    fingerprint,
    trustUnknown
  });
  const playwrightVersion = await ensurePlaywrightInstalled(repo);

  ensureWorkingTreeCleanWhenStrict(repo, strict);
  if (!strict && repo.isDirty) {
    warnings.push("Working tree is dirty under e2e-automation/sm-ui-refresh.");
  }

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
    warnings
  };
};
