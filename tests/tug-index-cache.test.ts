import { describe, expect, it } from "vitest";

import type { CompatibilityResult, RepoHandle } from "../src/tug/common/types.js";
import { buildIndexCacheKey } from "../src/tug/indexer/cache.js";

const compatibility: CompatibilityResult = {
  status: "supported",
  fingerprint: "fp_test123",
  knownTeardownHints: ["deleteAccount"]
};

const repo = (gitSha: string, isDirty = false): RepoHandle => ({
  absPath: "/tmp/repo",
  smRootPath: "/tmp/repo/e2e-automation/sm-ui-refresh",
  packageName: "@test/repo",
  packageVersion: "1.0.0",
  playwrightConfigPath: "/tmp/repo/e2e-automation/sm-ui-refresh/playwright.config.ts",
  tsconfigPath: "/tmp/repo/e2e-automation/sm-ui-refresh/tsconfig.json",
  gitSha,
  isDirty
});

describe("index cache keys", () => {
  it("invalidate when the clean repo git sha changes", () => {
    const first = buildIndexCacheKey({
      kind: "full",
      repo: repo("sha-one"),
      fingerprint: "fp_test123",
      compatibility
    });
    const second = buildIndexCacheKey({
      kind: "full",
      repo: repo("sha-two"),
      fingerprint: "fp_test123",
      compatibility
    });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("bypasses persistent cache keys for dirty repos", () => {
    expect(
      buildIndexCacheKey({
        kind: "full",
        repo: repo("sha-one", true),
        fingerprint: "fp_test123",
        compatibility
      })
    ).toBeNull();
  });
});
