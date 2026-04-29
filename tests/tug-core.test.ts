import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { ModuleKind, ScriptTarget } from "typescript";

import { validateRepositoryStructure } from "../src/tug/repo/validator.js";
import { computeFingerprint } from "../src/tug/repo/fingerprint.js";
import { parseIntent } from "../src/tug/intent/parser.js";
import { selectCandidateDeterministically } from "../src/tug/selector/deterministic.js";
import { parseCredentialMarker } from "../src/tug/execute/output-parser.js";
import { flushBufferedLines, readBufferedLines } from "../src/tug/execute/stdio.js";
import { TugError } from "../src/tug/common/errors.js";
import { buildPlaywrightDisplayTitle, buildPlaywrightGrepPattern } from "../src/tug/common/playwright.js";
import { quoteForShellValue } from "../src/tug/common/shell.js";
import {
  credentialProbeStatements,
  earlyReturnCredentialProbeStatements
} from "../src/tug/transform/credential-probe.js";
import { validateSyntaxRoundTrip } from "../src/tug/validate/syntax.js";
import { resolveSetupCacheRoot } from "../src/tug/common/paths.js";
import { buildSandbox, cleanupSandbox } from "../src/tug/sandbox/builder.js";
import {
  generatePlaywrightConfig,
  resolveReportersAgainstBaseDir
} from "../src/tug/sandbox/gen-playwright-config.js";
import {
  applySetupEnvDelta,
  buildSetupCacheKey,
  computeSetupEnvDelta,
  createSetupCachePayload,
  isSetupCachePayloadFresh,
  parseSetupCachePayload
} from "../src/tug/sandbox/setup-cache.js";
import {
  buildValidationCacheKey,
  isValidationCacheHit,
  writeValidationCacheHit
} from "../src/tug/validate/validation-cache.js";

const tempRoots: string[] = [];

const createTempDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tug-core-"));
  tempRoots.push(directory);
  return directory;
};

const writeFile = async (root: string, relativePath: string, contents: string) => {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
};

const createFixtureRepo = async () => {
  const repoDir = await createTempDir();
  await fs.mkdir(path.join(repoDir, ".git"));

  await writeFile(
    repoDir,
    "e2e-automation/sm-ui-refresh/package.json",
    JSON.stringify(
      {
        name: "@rediscloudauto/ui-refresh-automation-infra",
        version: "1.2.3"
      },
      null,
      2
    )
  );
  await writeFile(repoDir, "e2e-automation/sm-ui-refresh/tsconfig.json", "{\"compilerOptions\":{}}\n");
  await writeFile(repoDir, "e2e-automation/sm-ui-refresh/playwright.config.ts", "export default {}\n");
  await writeFile(
    repoDir,
    "e2e-automation/sm-ui-refresh/playwright-helpers/sm/sm.account.helpers.ts",
    "export const createAccount = async () => {}; export const deleteResources = async () => {};\n"
  );
  await writeFile(
    repoDir,
    "e2e-automation/sm-ui-refresh/playwright-helpers/sm/sm.subscription.helpers.ts",
    "export const createSubscription = async () => {};\n"
  );
  await writeFile(
    repoDir,
    "pnpm-lock.yaml",
    [
      "packages:",
      "  /@playwright/test@1.53.0:",
      "  /typescript@5.7.2:"
    ].join("\n")
  );

  await writeFile(
    repoDir,
    "e2e-automation/sm-ui-refresh/node_modules/@playwright/test/package.json",
    JSON.stringify({ version: "1.53.0" })
  );

  return repoDir;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("fingerprint", () => {
  it("is deterministic for the same repository state", async () => {
    const repoDir = await createFixtureRepo();
    const repo = await validateRepositoryStructure(repoDir);

    const first = await computeFingerprint(repo);
    const second = await computeFingerprint(repo);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^fp_[a-f0-9]{7}$/);
    expect(first.helperFiles).toEqual([
      "e2e-automation/sm-ui-refresh/playwright-helpers/sm/sm.account.helpers.ts",
      "e2e-automation/sm-ui-refresh/playwright-helpers/sm/sm.subscription.helpers.ts"
    ]);
  });
});

describe("selector", () => {
  it("ranks and selects a matching test deterministically", () => {
    const intent = parseIntent("US on-demand account with subscription");

    const selection = selectCandidateDeterministically({
      entries: [
        {
          filePath: "/tmp/a.spec.ts",
          testTitle: "creates EU annual account",
          describeTitles: ["Accounts"],
          tags: ["@eu"],
          helperImports: [],
          teardownCalls: [],
          scoreHints: {
            payerLocation: "eu",
            contractType: "annual"
          }
        },
        {
          filePath: "/tmp/b.spec.ts",
          testTitle: "creates US on-demand account with subscription",
          describeTitles: ["Accounts"],
          tags: ["@us"],
          helperImports: [],
          teardownCalls: [],
          scoreHints: {
            payerLocation: "us",
            contractType: "on-demand"
          }
        }
      ],
      intent,
      requireUnambiguous: true
    });

    expect(selection.selected.entry.filePath).toBe("/tmp/b.spec.ts");
    expect(selection.ambiguous).toBe(false);
  });
});

describe("playwright selection", () => {
  it("builds a grep pattern that tolerates Playwright separators between title segments", () => {
    const pattern = buildPlaywrightGrepPattern({
      describeTitles: ["Accounts", "Provisioning"],
      testTitle: "creates account"
    });
    const regex = new RegExp(pattern);

    expect(regex.test("chromium gen.spec.ts Accounts Provisioning creates account")).toBe(true);
    expect(regex.test("chromium gen.spec.ts Accounts › Provisioning › creates account")).toBe(true);
    expect(regex.test("Accounts   Provisioning creates account")).toBe(true);
    expect(regex.test("creates account")).toBe(false);
  });

  it("escapes regex metacharacters in describe and test titles", () => {
    const pattern = buildPlaywrightGrepPattern({
      describeTitles: ["Marketplace - Contract | Update"],
      testTitle: "RED-177632: handles AWS/GCP MP contract"
    });
    const regex = new RegExp(pattern);

    expect(
      regex.test(
        "chromium gen.spec.ts Marketplace - Contract | Update › RED-177632: handles AWS/GCP MP contract"
      )
    ).toBe(true);
    expect(regex.test("Marketplace - Contract X Update › RED-177632:")).toBe(false);
  });

  it("builds a display title joined with the list reporter separator and preserves special characters verbatim", () => {
    expect(
      buildPlaywrightDisplayTitle({
        describeTitles: ["Accounts", "Provisioning"],
        testTitle: "creates account"
      })
    ).toBe("Accounts › Provisioning › creates account");

    expect(
      buildPlaywrightDisplayTitle({
        describeTitles: ["Marketplace - Contract | Update"],
        testTitle: "RED-177632: handles AWS/GCP MP contract"
      })
    ).toBe("Marketplace - Contract | Update › RED-177632: handles AWS/GCP MP contract");
  });
});

describe("credential marker parsing", () => {
  it("extracts credentials from marker output", () => {
    const payload = parseCredentialMarker([
      "[playwright] hello",
      "__TUG_CRED__{\"email\":\"a@b.com\",\"password\":\"secret\"}"
    ]);

    expect(payload).toEqual({
      email: "a@b.com",
      password: "secret"
    });
  });

  it("fails when marker is missing", () => {
    expect(() => parseCredentialMarker(["nothing here"])).toThrowError(TugError);
    expect(() => parseCredentialMarker(["nothing here"])).toThrowError(
      expect.objectContaining({ reason: "CREDENTIAL_MARKER_MISSING" })
    );
  });

  it("reassembles split marker lines across stdout chunks", () => {
    const first = readBufferedLines({
      chunk: "__TUG_",
      remainder: ""
    });
    const second = readBufferedLines({
      chunk: "CRED__{\"email\":\"a@b.com\",\"password\":\"secret\"}\n",
      remainder: first.remainder
    });

    expect(first.lines).toEqual([]);
    expect(second.lines).toEqual(['__TUG_CRED__{"email":"a@b.com","password":"secret"}']);
    expect(flushBufferedLines(second.remainder)).toEqual([]);
    expect(parseCredentialMarker(second.lines)).toEqual({
      email: "a@b.com",
      password: "secret"
    });
  });
});

describe("credential probe generation", () => {
  it("typechecks even when the target test does not declare filler", () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ESNext,
        strict: true
      }
    });

    project.createSourceFile(
      "probe.ts",
      [
        "const testBody = () => {",
        ...credentialProbeStatements().map((statement) => `  ${statement}`),
        "};"
      ].join("\n"),
      { overwrite: true }
    );

    const diagnostics = project.getPreEmitDiagnostics();
    expect(diagnostics).toEqual([]);
  });

  it("includes marketplace and SM account identifiers in the probe payload", () => {
    const statements = credentialProbeStatements().join("\n");
    expect(statements).toContain("marketplaceId:");
    expect(statements).toContain("smAccountId:");
  });

  it("can typecheck the fast-mode early-return probe block", () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ESNext,
        strict: true
      }
    });

    project.createSourceFile(
      "probe-fast.ts",
      [
        "const testBody = () => {",
        ...earlyReturnCredentialProbeStatements().map((statement) => `  ${statement}`),
        ...credentialProbeStatements().map((statement) => `  ${statement}`),
        "};"
      ].join("\n"),
      { overwrite: true }
    );

    const diagnostics = project.getPreEmitDiagnostics();
    expect(diagnostics).toEqual([]);
  });

  it("does not reference possibly-TDZ locals in the fast-mode probe", () => {
    const statements = earlyReturnCredentialProbeStatements().join("\n");
    expect(statements).not.toContain("typeof marketplaceId");
    expect(statements).not.toContain("typeof accountId");
    expect(statements).not.toContain("typeof smAccountId");
  });
});

describe("shell escaping", () => {
  it("escapes single quotes for exported env vars", () => {
    expect(quoteForShellValue("pa'ss")).toBe("'pa'\\''ss'");
  });
});

describe("validateSyntaxRoundTrip", () => {
  it("accepts transformed source with unresolvable imports and unknown identifiers", () => {
    const source = [
      "import { test, expect } from \"@playwright/test\";",
      "import { login } from \"/abs/path/helpers/login\";",
      "",
      "test(\"creates account\", async ({ page }) => {",
      "  await login(page);",
      "  expect(1).toBe(1);",
      ...credentialProbeStatements().map((statement) => `  ${statement}`),
      "});"
    ].join("\n");

    expect(() => validateSyntaxRoundTrip(source, "gen.spec.ts")).not.toThrow();
  });

  it("throws VALIDATION_FAILED with diagnostic details when the source is not parseable", () => {
    const source = "test(\"broken\", async () => { const __tugCred = { ; });";

    let captured: TugError | undefined;
    try {
      validateSyntaxRoundTrip(source, "gen.spec.ts");
    } catch (error) {
      captured = error as TugError;
    }

    expect(captured).toBeInstanceOf(TugError);
    expect(captured?.reason).toBe("VALIDATION_FAILED");
    expect(captured?.details.length).toBeGreaterThan(0);
    expect(captured?.details.length).toBeLessThanOrEqual(5);
  });
});

describe("generatePlaywrightConfig", () => {
  const baseConfigPath = "/repo/e2e-automation/sm-ui-refresh/playwright.config.ts";
  const baseConfigDir = "/repo/e2e-automation/sm-ui-refresh";
  const setupCacheRoot = "/cache/setup-cache";
  const setupCacheCaptureScriptPath = "/cache/runs/abc/playwright.setup-cache.capture.mjs";
  const setupCachePersistScriptPath = "/cache/runs/abc/playwright.setup-cache.persist.mjs";
  const fingerprint = "fp_test123";
  const buildGenerated = () =>
    generatePlaywrightConfig({
      baseConfigPath,
      fingerprint,
      setupCacheRoot,
      setupCacheCaptureScriptPath,
      setupCachePersistScriptPath
    });

  it("imports the base config and overrides testDir/workers/retries", () => {
    const generated = buildGenerated();
    expect(generated).toContain(`import baseConfig from '${baseConfigPath}';`);
    expect(generated).toContain("testDir: __dirname");
    expect(generated).toContain("workers: 1");
    expect(generated).toContain("retries: 0");
  });

  it("constrains discovery to the sandbox spec via testMatch and testIgnore", () => {
    const generated = buildGenerated();
    expect(generated).toContain("testMatch: ['gen.spec.ts']");
    expect(generated).toContain("testIgnore: []");
  });

  it("replaces base projects with a single isolated tug-sandbox project that inherits use from chromium and keeps teardown paths as arrays", () => {
    const generated = buildGenerated();
    expect(generated).toContain("baseProjects.find((project) => project.name === 'chromium')");
    expect(generated).toContain("name: 'tug-sandbox'");
    expect(generated).toContain("projects: [sandboxProject]");
    expect(generated).toContain(
      "const resolvedGlobalTeardown = resolvePathSpecifiers((baseConfig as { globalTeardown?: unknown }).globalTeardown);"
    );
    expect(generated).toContain("globalSetup: resolvedGlobalSetup as never");
    expect(generated).toContain(
      "globalTeardown:\n    (resolvedGlobalTeardown.length > 0 ? resolvedGlobalTeardown : undefined) as never"
    );
  });

  it("anchors the reporter resolver at the base config directory, and embeds setup-cache hooks", () => {
    const generated = buildGenerated();

    expect(generated).toContain(`const baseConfigDir = ${JSON.stringify(baseConfigDir)};`);
    expect(generated).toContain(`const setupCacheRoot = ${JSON.stringify(setupCacheRoot)};`);
    expect(generated).toContain(
      `const setupCacheCaptureScriptPath = ${JSON.stringify(setupCacheCaptureScriptPath)};`
    );
    expect(generated).toContain(
      `const setupCachePersistScriptPath = ${JSON.stringify(setupCachePersistScriptPath)};`
    );
    expect(generated).toContain("reporter: resolveReporters(");
    expect(generated).toContain("buildSetupCacheKey(baseGlobalSetupPaths)");
    expect(generated).toContain('process.env["TUG_INTERNAL_SETUP_CACHE_FILE"]');
    expect(generated).toContain('process.env["TUG_INTERNAL_SETUP_CACHE_TTL_MS"]');
    expect(generated).toContain("setupCacheCaptureScriptPath");
    expect(generated).toContain("setupCachePersistScriptPath");
  });
});

describe("setup cache utilities", () => {
  it("computes env delta across added, changed, and removed variables", () => {
    const delta = computeSetupEnvDelta({
      before: {
        A: "same",
        B: "old",
        C: "remove"
      },
      after: {
        A: "same",
        B: "new",
        D: "add"
      }
    });

    expect(delta).toEqual({
      B: "new",
      C: null,
      D: "add"
    });
  });

  it("applies env deltas from a valid cache hit", () => {
    const target: NodeJS.ProcessEnv = {
      A: "same",
      B: "old",
      C: "remove"
    };
    applySetupEnvDelta({
      target,
      delta: {
        B: "new",
        C: null,
        D: "add"
      }
    });

    expect(target).toEqual({
      A: "same",
      B: "new",
      D: "add"
    });
  });

  it("treats expired or invalid payloads as cache misses", () => {
    const now = Date.now();
    const fresh = createSetupCachePayload({
      envDelta: { A: "1" },
      ttlMs: 1_000,
      nowMs: now
    });
    const expired = createSetupCachePayload({
      envDelta: { A: "1" },
      ttlMs: 1_000,
      nowMs: now - 10_000
    });

    expect(isSetupCachePayloadFresh({ payload: fresh, nowMs: now + 200 })).toBe(true);
    expect(isSetupCachePayloadFresh({ payload: expired, nowMs: now })).toBe(false);
    expect(parseSetupCachePayload(JSON.stringify(fresh))).toEqual(fresh);
    expect(parseSetupCachePayload("{not-json")).toBeNull();
    expect(parseSetupCachePayload(JSON.stringify({ version: 99, envDelta: {} }))).toBeNull();
  });

  it("uses routing environment and setup paths in the cache key", () => {
    const base = {
      fingerprint: "fp_abc1234",
      baseConfigPath: "/repo/playwright.config.ts",
      globalSetupPaths: ["/repo/global-setup.ts"]
    };
    const keyA = buildSetupCacheKey({
      ...base,
      routeEnv: {
        env: "qa.qa",
        TUG_ENVIRONMENT: "qa.qa",
        cloudProvider: "gcp",
        cloudService: "gcp",
        marketplace: "gcp",
        region: "us-central1"
      }
    });
    const keyB = buildSetupCacheKey({
      ...base,
      routeEnv: {
        env: "qa.qa",
        TUG_ENVIRONMENT: "qa.qa",
        cloudProvider: "aws",
        cloudService: "aws",
        marketplace: "aws",
        region: "us-east-1"
      }
    });

    expect(keyA).not.toBe(keyB);
  });
});

describe("validation cache utilities", () => {
  it("tracks hit/miss and expiry for persisted validation records", async () => {
    const cacheHome = await createTempDir();
    const previousXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheHome;

    try {
      const key = buildValidationCacheKey({
        kind: "repo-list",
        components: {
          fingerprint: "fp_abc1234",
          environment: "qa.qa"
        }
      });

      await expect(
        isValidationCacheHit({
          kind: "repo-list",
          key,
          nowMs: 1_000
        })
      ).resolves.toBe(false);

      await writeValidationCacheHit({
        kind: "repo-list",
        key,
        ttlMs: 1_000,
        nowMs: 1_000
      });

      await expect(
        isValidationCacheHit({
          kind: "repo-list",
          key,
          nowMs: 1_500
        })
      ).resolves.toBe(true);

      await expect(
        isValidationCacheHit({
          kind: "repo-list",
          key,
          nowMs: 2_100
        })
      ).resolves.toBe(false);
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = previousXdg;
      }
    }
  });
});

describe("sandbox builder setup-cache artifacts", () => {
  it("writes setup-cache helper scripts and references them from generated Playwright config", async () => {
    const repoDir = await createFixtureRepo();
    const repo = await validateRepositoryStructure(repoDir);
    const fingerprint = (await computeFingerprint(repo)).fingerprint;

    const sandbox = await buildSandbox({
      repo,
      fingerprint,
      transform: {
        transformedText: "import { test } from '@playwright/test';\n\ntest('x', async () => {});\n",
        originalText: "import { test } from '@playwright/test';\n\ntest('x', async () => {});\n",
        selectedTitle: "x",
        sourceFile: "x.spec.ts",
        removedCalls: [],
        confidence: 1,
        unknownHookCalls: [],
        uncertainIdentifiers: []
      },
      diff: "",
      runPlan: {
        generatedAt: new Date().toISOString()
      }
    });

    try {
      const capturePath = path.join(sandbox.path, "playwright.setup-cache.capture.mjs");
      const persistPath = path.join(sandbox.path, "playwright.setup-cache.persist.mjs");
      const generatedConfig = await fs.readFile(sandbox.playwrightConfigPath, "utf8");
      const captureSource = await fs.readFile(capturePath, "utf8");
      const persistSource = await fs.readFile(persistPath, "utf8");

      expect(captureSource).toContain("__TUG_SETUP_CACHE_BEFORE_ENV__");
      expect(persistSource).toContain("TUG_INTERNAL_SETUP_CACHE_FILE");
      expect(persistSource).toContain("TUG_INTERNAL_SETUP_CACHE_TTL_MS");

      expect(generatedConfig).toContain(JSON.stringify(resolveSetupCacheRoot().replace(/\\/g, "/")));
      expect(generatedConfig).toContain(JSON.stringify(capturePath.replace(/\\/g, "/")));
      expect(generatedConfig).toContain(JSON.stringify(persistPath.replace(/\\/g, "/")));
      expect(generatedConfig).toContain("resolvedGlobalSetup = [");
    } finally {
      await cleanupSandbox(sandbox);
    }
  });
});

describe("resolveReportersAgainstBaseDir", () => {
  const baseDir = "/repo/e2e-automation/sm-ui-refresh";

  it("absolutizes relative reporter module specifiers in tuple entries", () => {
    const resolved = resolveReportersAgainstBaseDir(
      [
        ["./reporters/enhanced-json-reporter.ts", { outputDir: "report" }],
        ["./reporters/enhanced-playwright-console-reporter.ts"],
        ["line"],
        ["@rediscloudauto/rp-playwright-reporter", { foo: 1 }]
      ],
      baseDir
    );

    expect(resolved).toEqual([
      [path.resolve(baseDir, "./reporters/enhanced-json-reporter.ts"), { outputDir: "report" }],
      [path.resolve(baseDir, "./reporters/enhanced-playwright-console-reporter.ts")],
      ["line"],
      ["@rediscloudauto/rp-playwright-reporter", { foo: 1 }]
    ]);
  });

  it("absolutizes a bare relative-string reporter and leaves package specifiers alone", () => {
    expect(resolveReportersAgainstBaseDir("./reporters/r.ts", baseDir)).toBe(
      path.resolve(baseDir, "./reporters/r.ts")
    );
    expect(resolveReportersAgainstBaseDir("line", baseDir)).toBe("line");
    expect(resolveReportersAgainstBaseDir(undefined, baseDir)).toBeUndefined();
  });
});
