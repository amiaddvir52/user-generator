import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { createConfigStore, resolveConfigDirectory } from "./config-store.js";
import type { EnvironmentOption, ProviderOption } from "../shared/contracts.js";
import { TugError } from "../tug/common/errors.js";
import { ensureLoggerReady, resetLoggerForTesting } from "../tug/common/logger.js";

const tempRoots: string[] = [];

const createTempDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "user-generator-"));
  tempRoots.push(directory);
  return directory;
};

const writeFile = async (root: string, relativePath: string, contents: string) => {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
};

const createGitRepo = async () => {
  const directory = await createTempDir();
  await fs.mkdir(path.join(directory, ".git"));
  return directory;
};

const createEnvironmentFixtureRepo = async () => {
  const directory = await createGitRepo();

  await writeFile(
    directory,
    "e2e-automation/sm-ui-refresh/types/environments.ts",
    `export enum Environments {
  QA = 'qa.qa',
  STAGING = 'staging.qa',
  DEV = 'sm.k8s-dev.sm-qa.qa',
  DEV_UI_REFRESH = 'sm.k8s-dev-uirefresh.sm-qa.qa',
  AA = 'sm.k8s-aa.sm-qa.qa',
  BILLING = 'sm.k8s-billing.sm-qa.qa',
  CLOUDAPI = 'sm.k8s-cloudapi.sm-qa.qa',
  GCP = 'sm.k8s-gcp.sm-qa.qa',
  IDM = 'sm.k8s-idm.sm-qa.qa',
  INTEGRATION = 'sm.k8s-integration.sm-qa.qa',
  MW = 'sm.k8s-mw.sm-qa.qa',
  PSC = 'sm.k8s-psc.sm-qa.qa',
  RCP = 'sm.k8s-rcp.sm-qa.qa'
}
`
  );
  await writeFile(
    directory,
    "e2e-automation/sm-ui-refresh/playwright-helpers/environment.ts",
    `const k8sDomains = {
  'qa.qa': 'sm.k8s-dev-uirefresh.sm-qa.qa',
  'aa.qa': 'sm.k8s-aa.sm-qa.qa',
  gcp: 'sm.k8s-gcp.sm-qa.qa'
};
`
  );
  await writeFile(
    directory,
    "packages/api-clients/http-client.ts",
    `const k8sDomains = {
  'cloudapi.qa': 'sm.k8s-cloudapi.sm-qa.qa'
};
`
  );
  await writeFile(
    directory,
    "packages/api-clients/http-clients/sm-envs-client.ts",
    `const envList = ['integration.qa', 'qa.qa', 'staging.qa'];
if (env === 'cloudapi.qa') {
  return env;
}
`
  );
  await writeFile(
    directory,
    "microservices/feature-flags/src/features/get-envs.ts",
    `export const getEnvs = () => {
  const envs: string[] = [];
  envs.push('aa.qa');
  return envs;
};
`
  );
  await writeFile(
    directory,
    "e2e-automation/sm-ui-refresh/continuous-integration/sm-core/core.groovy",
    `choice(
  name: 'env',
  choices: ['sm.k8s-auto.sm-qa.qa', 'sm.k8s-billing-dev.sm-qa.qa', 'sm.k8s-gh.sm-qa.qa'].join('\\n')
)
`
  );
  await writeFile(
    directory,
    "e2e-automation/sm-ui-refresh/continuous-integration/nashville/nashville.groovy",
    `editableChoice(
  name: 'environments',
  choices: ['sm.sm-poc.sm-qa.qa'].join('\\n')
)
`
  );

  return directory;
};

const createMockProviders = (): ProviderOption[] => [
  {
    id: "augment",
    label: "Augment",
    available: true,
    availableBackends: ["augment-sdk", "augment-auggie"],
    defaultBackend: "augment-sdk",
    warnings: []
  },
  {
    id: "codex",
    label: "Codex",
    available: true,
    availableBackends: ["codex-cli"],
    defaultBackend: "codex-cli",
    warnings: []
  },
  {
    id: "cursor",
    label: "Cursor",
    available: false,
    availableBackends: [],
    warnings: ["Cursor remains disabled because no supported backend was detected."],
    reason: "Cursor is intentionally disabled until user-generator has a concrete Cursor execution backend."
  }
];

const createMockEnvironments = (): EnvironmentOption[] => [
  {
    value: "qa.qa",
    category: "enum",
    normalizedValue: "sm.k8s-dev-uirefresh.sm-qa.qa",
    sources: ["e2e-automation/sm-ui-refresh/types/environments.ts:2"],
    warnings: ["Variant also defined as sm.k8s-dev-uirefresh.sm-qa.qa."]
  },
  {
    value: "staging.qa",
    category: "enum",
    sources: ["e2e-automation/sm-ui-refresh/types/environments.ts:3"],
    warnings: []
  }
];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("config path resolution", () => {
  it("uses the expected macOS config directory", () => {
    expect(
      resolveConfigDirectory({
        platform: "darwin",
        homeDir: "/Users/dev",
        env: {}
      })
    ).toBe("/Users/dev/Library/Application Support/user-generator");
  });

  it("uses the expected Linux config directory", () => {
    expect(
      resolveConfigDirectory({
        platform: "linux",
        homeDir: "/home/dev",
        env: {}
      })
    ).toBe("/home/dev/.config/user-generator");
  });

  it("uses the expected Windows config directory", () => {
    expect(
      resolveConfigDirectory({
        platform: "win32",
        homeDir: "C:\\Users\\dev",
        env: {
          APPDATA: "C:\\Users\\dev\\AppData\\Roaming"
        }
      })
    ).toBe(path.join("C:\\Users\\dev\\AppData\\Roaming", "user-generator"));
  });
});

describe("config store recovery", () => {
  it("backs up a corrupted config and returns a fresh config", async () => {
    const configDir = await createTempDir();
    const store = createConfigStore({ configDir });

    await fs.writeFile(path.join(configDir, "config.json"), "{not-valid-json", "utf8");

    const loadResult = await store.load();

    expect(loadResult.recoveredFromCorruption).toBe(true);
    expect(loadResult.config).toEqual({ version: 2 });
    await expect(fs.access(path.join(configDir, "config.json.bak"))).resolves.toBeUndefined();
  });

  it("migrates legacy version 1 configs to version 2", async () => {
    const configDir = await createTempDir();
    const store = createConfigStore({ configDir });

    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          version: 1,
          aiProvider: "codex",
          automationRepoPath: "/tmp/automation",
          lastEnvironment: "dev"
        },
        null,
        2
      ),
      "utf8"
    );

    const loadResult = await store.load();

    expect(loadResult.config).toEqual({
      version: 2,
      aiProvider: "codex",
      automationRepoPath: "/tmp/automation",
      lastEnvironment: "qa.qa"
    });
  });
});

describe("onboarding API", () => {
  it("returns dynamic provider and environment catalogs, persists a resolved backend, and executes prompts", async () => {
    const configDir = await createTempDir();
    const repoDir = await createEnvironmentFixtureRepo();
    const repoRealPath = await fs.realpath(repoDir);
    const executeProviderPrompt = vi.fn().mockResolvedValue({
      output: "provider-ok",
      warnings: ["using mock backend"]
    });

    const app = await buildApp({
      configDir,
      services: {
        buildEnvironmentCatalog: async (automationRepoPath?: string) => ({
          environments: automationRepoPath ? createMockEnvironments() : [],
          warnings: automationRepoPath ? ["Environment variants are defined in multiple forms: qa.qa, sm.k8s-dev-uirefresh.sm-qa.qa"] : []
        }),
        buildProviderCatalog: async () => ({
          providers: createMockProviders(),
          warnings: ["Unavailable providers were detected and will stay disabled: cursor"]
        }),
        executeProviderPrompt
      }
    });

    const initialResponse = await app.inject({
      method: "GET",
      url: "/api/config"
    });

    expect(initialResponse.statusCode).toBe(200);
    expect(initialResponse.json()).toMatchObject({
      onboardingStep: "provider",
      config: {
        version: 2
      },
      environments: [],
      providers: expect.arrayContaining([
        expect.objectContaining({ id: "codex", defaultBackend: "codex-cli" })
      ])
    });

    const unavailableProviderResponse = await app.inject({
      method: "POST",
      url: "/api/config/provider",
      payload: {
        aiProvider: "cursor"
      }
    });

    expect(unavailableProviderResponse.statusCode).toBe(400);

    const providerResponse = await app.inject({
      method: "POST",
      url: "/api/config/provider",
      payload: {
        aiProvider: "augment"
      }
    });

    expect(providerResponse.statusCode).toBe(200);
    expect(providerResponse.json()).toMatchObject({
      onboardingStep: "automationRepo",
      config: {
        aiProvider: "augment",
        providerBackend: "augment-sdk"
      }
    });

    const repoResponse = await app.inject({
      method: "POST",
      url: "/api/config/automation-repo",
      payload: {
        automationRepoPath: repoDir
      }
    });

    expect(repoResponse.statusCode).toBe(200);
    expect(repoResponse.json()).toMatchObject({
      onboardingStep: "environment",
      config: {
        automationRepoPath: repoRealPath
      },
      environments: expect.arrayContaining([
        expect.objectContaining({ value: "qa.qa" }),
        expect.objectContaining({ value: "staging.qa" })
      ])
    });

    const invalidEnvironment = await app.inject({
      method: "POST",
      url: "/api/config/environment",
      payload: {
        environment: "dev"
      }
    });

    expect(invalidEnvironment.statusCode).toBe(400);

    const environmentResponse = await app.inject({
      method: "POST",
      url: "/api/config/environment",
      payload: {
        environment: "qa.qa"
      }
    });

    expect(environmentResponse.statusCode).toBe(200);
    expect(environmentResponse.json()).toMatchObject({
      config: {
        lastEnvironment: "qa.qa"
      }
    });

    const executionResponse = await app.inject({
      method: "POST",
      url: "/api/provider/execute",
      payload: {
        prompt: "Can you use the selected provider?"
      }
    });

    expect(executionResponse.statusCode).toBe(200);
    expect(executionResponse.json()).toMatchObject({
      provider: "augment",
      backend: "augment-sdk",
      environment: "qa.qa",
      output: "provider-ok",
      warnings: ["using mock backend"]
    });
    expect(executeProviderPrompt).toHaveBeenCalledWith({
      backend: "augment-sdk",
      environment: "qa.qa",
      prompt: "Can you use the selected provider?",
      provider: "augment",
      repositoryPath: repoRealPath
    });

    await app.close();
  });

  it("suppresses non-actionable catalog diagnostics from top-level config warnings", async () => {
    const configDir = await createTempDir();
    const repoDir = await createGitRepo();
    const app = await buildApp({
      configDir,
      services: {
        buildEnvironmentCatalog: async (automationRepoPath?: string) => ({
          environments: automationRepoPath ? createMockEnvironments() : [],
          warnings: automationRepoPath
            ? [
                "CI-only environments were discovered outside the typed enum: sm.k8s-auto.sm-qa.qa",
                "Environment variants are defined in multiple forms: qa.qa, sm.k8s-dev-uirefresh.sm-qa.qa"
              ]
            : []
        }),
        buildProviderCatalog: async () => ({
          providers: createMockProviders(),
          warnings: ["Unavailable providers were detected and will stay disabled: cursor"]
        }),
        executeProviderPrompt: vi.fn()
      }
    });

    await app.inject({
      method: "POST",
      url: "/api/config/provider",
      payload: {
        aiProvider: "augment"
      }
    });

    await app.inject({
      method: "POST",
      url: "/api/config/automation-repo",
      payload: {
        automationRepoPath: repoDir
      }
    });

    const configResponse = await app.inject({
      method: "GET",
      url: "/api/config"
    });

    expect(configResponse.statusCode).toBe(200);
    expect(configResponse.json()).toMatchObject({
      warnings: []
    });

    await app.close();
  });

  it("updates saved settings atomically", async () => {
    const configDir = await createTempDir();
    const validRepoDir = await createGitRepo();
    const validRepoRealPath = await fs.realpath(validRepoDir);
    const replacementRepoDir = await createGitRepo();
    const replacementRepoRealPath = await fs.realpath(replacementRepoDir);
    const app = await buildApp({
      configDir,
      services: {
        buildEnvironmentCatalog: async (automationRepoPath?: string) => ({
          environments: automationRepoPath ? createMockEnvironments() : [],
          warnings: []
        }),
        buildProviderCatalog: async () => ({
          providers: createMockProviders(),
          warnings: []
        }),
        executeProviderPrompt: vi.fn()
      }
    });

    await app.inject({
      method: "POST",
      url: "/api/config/provider",
      payload: {
        aiProvider: "codex"
      }
    });

    await app.inject({
      method: "POST",
      url: "/api/config/automation-repo",
      payload: {
        automationRepoPath: validRepoDir
      }
    });

    const invalidUpdate = await app.inject({
      method: "POST",
      url: "/api/config/settings",
      payload: {
        aiProvider: "cursor",
        automationRepoPath: "/missing/repo"
      }
    });

    expect(invalidUpdate.statusCode).toBe(400);

    const unchangedConfig = await app.inject({
      method: "GET",
      url: "/api/config"
    });

    expect(unchangedConfig.json()).toMatchObject({
      config: {
        aiProvider: "codex",
        providerBackend: "codex-cli",
        automationRepoPath: validRepoRealPath
      }
    });

    const validUpdate = await app.inject({
      method: "POST",
      url: "/api/config/settings",
      payload: {
        aiProvider: "augment",
        automationRepoPath: replacementRepoDir
      }
    });

    expect(validUpdate.statusCode).toBe(200);
    expect(validUpdate.json()).toMatchObject({
      config: {
        aiProvider: "augment",
        providerBackend: "augment-sdk",
        automationRepoPath: replacementRepoRealPath
      }
    });

    await app.close();
  });
});
describe("user generation API", () => {
  const buildConfiguredApp = async (executeUserGeneration: ReturnType<typeof vi.fn>) => {
    const configDir = await createTempDir();
    const repoDir = await createEnvironmentFixtureRepo();
    const app = await buildApp({
      configDir,
      services: {
        buildEnvironmentCatalog: async (automationRepoPath?: string) => ({
          environments: automationRepoPath ? createMockEnvironments() : [],
          warnings: []
        }),
        buildProviderCatalog: async () => ({
          providers: createMockProviders(),
          warnings: []
        }),
        executeProviderPrompt: vi.fn(),
        executeUserGeneration
      }
    });

    await app.inject({
      method: "POST",
      url: "/api/config/provider",
      payload: { aiProvider: "augment" }
    });
    await app.inject({
      method: "POST",
      url: "/api/config/automation-repo",
      payload: { automationRepoPath: repoDir }
    });
    await app.inject({
      method: "POST",
      url: "/api/config/environment",
      payload: { environment: "qa.qa" }
    });

    return { app, repoDir };
  };

  it("returns credentials on success and invokes the executor with saved config", async () => {
    const executeUserGeneration = vi.fn().mockResolvedValue({
      ok: true,
      fingerprint: "fp-123",
      compatibility: "supported",
      selectedTest: { filePath: "/tmp/spec.ts", title: "creates user" },
      environment: "qa.qa",
      executionMode: "fast",
      fallbackTriggered: false,
      confidence: 0.95,
      removedCalls: [],
      sandboxPath: "/tmp/sandbox",
      credentials: { email: "a@b.com", password: "secret" },
      warnings: []
    });

    const { app } = await buildConfiguredApp(executeUserGeneration);

    const response = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: { prompt: "US account with on-demand contract" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fingerprint: "fp-123",
      selectedTest: { title: "creates user" },
      credentials: { email: "a@b.com", password: "secret" }
    });
    expect(executeUserGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "US account with on-demand contract",
        environment: "qa.qa",
        executionMode: "fast",
        allowAutoFallback: true,
        trustUnknown: true,
        trustUncertainTeardown: true
      })
    );

    const historyResponse = await app.inject({
      method: "GET",
      url: "/api/run-history"
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json()).toMatchObject({
      maxEntries: 50,
      entries: [
        {
          request: {
            prompt: "US account with on-demand contract",
            environment: "qa.qa",
            executionMode: "fast",
            allowAutoFallback: true,
            enableRcpMock: false,
            trustUnknown: true,
            trustUncertainTeardown: true,
            keepSandbox: false,
            reindex: false
          },
          result: {
            executionMode: "fast",
            fallbackTriggered: false,
            selectedTest: { title: "creates user" },
            credentials: { email: "a@b.com", password: "secret" }
          }
        }
      ]
    });

    await app.close();
  });

  it("maps CANDIDATE_AMBIGUOUS to 409 with resolvable flag", async () => {
    const executeUserGeneration = vi
      .fn()
      .mockRejectedValue(
        new TugError("CANDIDATE_AMBIGUOUS", "Multiple candidate tests matched with close scores.", [
          "creates user (a.spec.ts)",
          "creates admin (b.spec.ts)"
        ])
      );

    const { app } = await buildConfiguredApp(executeUserGeneration);

    const response = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: { prompt: "create" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      reason: "CANDIDATE_AMBIGUOUS",
      resolvable: true,
      details: expect.arrayContaining(["creates user (a.spec.ts)"])
    });

    const historyResponse = await app.inject({
      method: "GET",
      url: "/api/run-history"
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json()).toMatchObject({
      entries: []
    });

    await app.close();
  });

  it("returns the run log path on a separate logFile field, not inside details", async () => {
    const logDir = await createTempDir();
    const logFile = path.join(logDir, "tug-test.log");
    const previousLogEnv = process.env.TUG_LOG_FILE;
    process.env.TUG_LOG_FILE = logFile;
    resetLoggerForTesting();
    await ensureLoggerReady();

    try {
      const candidates = ["creates user (a.spec.ts)", "creates admin (b.spec.ts)"];
      const executeUserGeneration = vi
        .fn()
        .mockRejectedValue(
          new TugError("CANDIDATE_AMBIGUOUS", "Multiple candidate tests matched with close scores.", candidates)
        );

      const { app } = await buildConfiguredApp(executeUserGeneration);

      const response = await app.inject({
        method: "POST",
        url: "/api/run",
        payload: { prompt: "create" }
      });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { details?: string[]; logFile?: string };
      expect(body.details).toEqual(candidates);
      expect(body.details?.some((detail) => detail.startsWith("Run log:"))).toBe(false);
      expect(body.logFile).toBe(logFile);

      await app.close();
    } finally {
      if (previousLogEnv === undefined) {
        delete process.env.TUG_LOG_FILE;
      } else {
        process.env.TUG_LOG_FILE = previousLogEnv;
      }
      resetLoggerForTesting();
    }
  });

  it("preserves explicit trust overrides from the request body", async () => {
    const executeUserGeneration = vi.fn().mockResolvedValue({
      ok: true,
      fingerprint: "fp-123",
      compatibility: "supported",
      selectedTest: { filePath: "/tmp/spec.ts", title: "creates user" },
      environment: "qa.qa",
      executionMode: "fast",
      fallbackTriggered: false,
      confidence: 0.95,
      removedCalls: [],
      sandboxPath: "/tmp/sandbox",
      credentials: { email: "a@b.com", password: "secret" },
      warnings: []
    });

    const { app } = await buildConfiguredApp(executeUserGeneration);

    const response = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: {
        prompt: "US account with on-demand contract",
        trustUnknown: false,
        trustUncertainTeardown: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(executeUserGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        trustUnknown: false,
        trustUncertainTeardown: false
      })
    );

    await app.close();
  });

  it("forwards enableRcpMock when requested", async () => {
    const executeUserGeneration = vi.fn().mockResolvedValue({
      ok: true,
      fingerprint: "fp-123",
      compatibility: "supported",
      selectedTest: { filePath: "/tmp/spec.ts", title: "creates user" },
      environment: "qa.qa",
      executionMode: "fast",
      fallbackTriggered: false,
      confidence: 0.95,
      removedCalls: [],
      sandboxPath: "/tmp/sandbox",
      credentials: { email: "a@b.com", password: "secret" },
      warnings: []
    });

    const { app } = await buildConfiguredApp(executeUserGeneration);

    const response = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: {
        prompt: "US account with on-demand contract",
        enableRcpMock: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(executeUserGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        enableRcpMock: true
      })
    );

    await app.close();
  });

  it("maps CONFIG_INCOMPLETE to 400", async () => {
    const executeUserGeneration = vi
      .fn()
      .mockRejectedValue(new TugError("CONFIG_INCOMPLETE", "Repository path is required."));

    const { app } = await buildConfiguredApp(executeUserGeneration);

    const response = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: { prompt: "anything" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      reason: "CONFIG_INCOMPLETE",
      resolvable: false
    });

    await app.close();
  });

  it("rejects bodies without prompt or explicit spec+test", async () => {
    const executeUserGeneration = vi.fn();
    const { app } = await buildConfiguredApp(executeUserGeneration);

    const response = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(executeUserGeneration).not.toHaveBeenCalled();

    await app.close();
  });

  it("retains only the latest 50 successful runs", async () => {
    const executeUserGeneration = vi.fn().mockImplementation(async ({ prompt }: { prompt?: string }) => ({
      ok: true,
      fingerprint: `fp-${prompt ?? "unknown"}`,
      compatibility: "supported" as const,
      selectedTest: { filePath: "/tmp/spec.ts", title: `creates ${prompt}` },
      environment: "qa.qa",
      executionMode: "fast" as const,
      fallbackTriggered: false,
      confidence: 0.95,
      removedCalls: [],
      sandboxPath: "/tmp/sandbox",
      credentials: { email: "a@b.com", password: "secret" },
      warnings: []
    }));

    const { app } = await buildConfiguredApp(executeUserGeneration);

    for (let index = 0; index < 55; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/run",
        payload: { prompt: `prompt-${index}` }
      });
      expect(response.statusCode).toBe(200);
    }

    const historyResponse = await app.inject({
      method: "GET",
      url: "/api/run-history"
    });
    expect(historyResponse.statusCode).toBe(200);
    const historyPayload = historyResponse.json() as {
      maxEntries: number;
      entries: Array<{ request: { prompt?: string } }>;
    };
    expect(historyPayload.maxEntries).toBe(50);
    expect(historyPayload.entries).toHaveLength(50);
    expect(historyPayload.entries.some((entry) => entry.request.prompt === "prompt-0")).toBe(false);
    expect(historyPayload.entries.some((entry) => entry.request.prompt === "prompt-54")).toBe(true);

    await app.close();
  });

  it("does not clear run history when config reset is called", async () => {
    const executeUserGeneration = vi.fn().mockResolvedValue({
      ok: true,
      fingerprint: "fp-123",
      compatibility: "supported",
      selectedTest: { filePath: "/tmp/spec.ts", title: "creates user" },
      environment: "qa.qa",
      executionMode: "fast",
      fallbackTriggered: false,
      confidence: 0.95,
      removedCalls: [],
      sandboxPath: "/tmp/sandbox",
      credentials: { email: "a@b.com", password: "secret" },
      warnings: []
    });

    const { app } = await buildConfiguredApp(executeUserGeneration);

    const runResponse = await app.inject({
      method: "POST",
      url: "/api/run",
      payload: { prompt: "US account with on-demand contract" }
    });
    expect(runResponse.statusCode).toBe(200);

    const resetResponse = await app.inject({
      method: "POST",
      url: "/api/config/reset"
    });
    expect(resetResponse.statusCode).toBe(200);

    const historyResponse = await app.inject({
      method: "GET",
      url: "/api/run-history"
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json()).toMatchObject({
      entries: [expect.objectContaining({ result: expect.objectContaining({ fingerprint: "fp-123" }) })]
    });

    await app.close();
  });
});
