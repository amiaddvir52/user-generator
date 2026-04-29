import { locateRepository } from "../repo/locator.js";
import { evaluateCompatibility } from "../repo/compatibility.js";
import { computeFingerprint } from "../repo/fingerprint.js";
import {
  ensurePlaywrightInstalled,
  ensureWorkingTreeCleanWhenStrict,
  validateRepositoryStructure
} from "../repo/validator.js";
import { runPlaywrightList } from "./playwright-list.js";

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
    await runPlaywrightList({
      repo,
      configPath: repo.playwrightConfigPath,
      env
    });
  }

  return {
    repo,
    fingerprint,
    compatibility,
    playwrightVersion,
    warnings
  };
};
