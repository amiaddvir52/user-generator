import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";

import {
  AIProviderSchema,
  AppConfigSchema,
  ProviderBackendSchema,
  getOnboardingStep,
  type AppConfig,
  type ProviderBackend
} from "../shared/config.js";
import type {
  ApiError,
  ConfigResponse,
  RunHistoryEntry,
  RunHistoryResponse,
  UserGenerationError,
  UserGenerationResponse
} from "../shared/contracts.js";
import { normalizeSupportedEnvironment } from "../shared/supported-environments.js";
import { createConfigStore } from "./config-store.js";
import { buildEnvironmentCatalog } from "./environment-catalog.js";
import { buildProviderCatalog } from "./provider-catalog.js";
import { executeProviderPrompt } from "./provider-runtime.js";
import { executeUserGeneration } from "./run-service.js";
import { createRunHistoryStore } from "./run-history-store.js";
import { isTugError } from "../tug/common/errors.js";
import { getLogFilePath } from "../tug/common/logger.js";
import type { ReasonCode } from "../tug/common/types.js";

type ProviderCatalogResult = Awaited<ReturnType<typeof buildProviderCatalog>>;
type EnvironmentCatalogResult = Awaited<ReturnType<typeof buildEnvironmentCatalog>>;

type BuildAppOptions = {
  configDir?: string;
  webRoot?: string;
  services?: {
    buildEnvironmentCatalog?: typeof buildEnvironmentCatalog;
    buildProviderCatalog?: typeof buildProviderCatalog;
    executeProviderPrompt?: typeof executeProviderPrompt;
    executeUserGeneration?: typeof executeUserGeneration;
  };
};

const RESOLVABLE_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "CANDIDATE_AMBIGUOUS",
  "FINGERPRINT_UNKNOWN",
  "TEARDOWN_IDENTITY_UNSURE",
  "TEARDOWN_HOOK_HAS_UNKNOWN_CALL",
  "WORKING_TREE_DIRTY"
]);

const CONFIG_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "PATH_INVALID",
  "PATH_NOT_GIT_REPO",
  "STRUCTURE_INVALID",
  "VALIDATION_FAILED",
  "CREDENTIAL_MARKER_MISSING",
  "ENV_INCOMPLETE",
  "CONFIG_INCOMPLETE",
  "SANDBOX_COLLISION",
  "TRANSFORM_INCOMPLETE",
  "SERIAL_DEPENDENCY"
]);

const statusForReason = (reason: ReasonCode): number => {
  if (RESOLVABLE_REASONS.has(reason)) {
    return 409;
  }
  if (CONFIG_REASONS.has(reason)) {
    return 400;
  }
  return 500;
};

const createSerialQueue = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
};

const ProviderBodySchema = z.object({
  aiProvider: AIProviderSchema,
  providerBackend: ProviderBackendSchema.optional()
});

const RepoBodySchema = z.object({
  automationRepoPath: z.string().trim().min(1, "Automation repo path is required.")
});

const SettingsBodySchema = z.object({
  aiProvider: AIProviderSchema,
  providerBackend: ProviderBackendSchema.optional(),
  automationRepoPath: z.string().trim().min(1, "Automation repo path is required.")
});

const EnvironmentBodySchema = z.object({
  environment: z.string().trim().min(1, "Environment is required.")
});

const ProviderExecutionBodySchema = z.object({
  prompt: z.string().trim().min(1, "Prompt is required."),
  environment: z.string().trim().min(1).optional()
});

const UserGenerationBodySchema = z
  .object({
    prompt: z.string().trim().min(1).optional(),
    spec: z.string().trim().min(1).optional(),
    test: z.string().trim().min(1).optional(),
    environment: z.string().trim().min(1).optional(),
    enableRcpMock: z.boolean().optional(),
    trustUnknown: z.boolean().optional(),
    trustUncertainTeardown: z.boolean().optional(),
    keepSandbox: z.boolean().optional(),
    reindex: z.boolean().optional()
  })
  .refine(
    (value) => Boolean(value.prompt) || (Boolean(value.spec) && Boolean(value.test)),
    { message: "Provide a prompt, or both spec and test." }
  );

const errorResponse = (message: string, details?: string[]): ApiError => ({
  message,
  ...(details && details.length > 0 ? { details } : {})
});

const validateAutomationRepoPath = async (candidatePath: string) => {
  const trimmedPath = candidatePath.trim();

  if (!path.isAbsolute(trimmedPath)) {
    return {
      ok: false as const,
      message: "Automation repo path must be an absolute path."
    };
  }

  try {
    const repoStats = await fs.stat(trimmedPath);

    if (!repoStats.isDirectory()) {
      return {
        ok: false as const,
        message: "Automation repo path must point to a directory."
      };
    }

    await fs.access(path.join(trimmedPath, ".git"));

    return {
      ok: true as const,
      normalizedPath: await fs.realpath(trimmedPath)
    };
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;

    if (fsError.code === "ENOENT") {
      return {
        ok: false as const,
        message: "Automation repo path does not exist or is missing a .git entry."
      };
    }

    return {
      ok: false as const,
      message: "Unable to validate the automation repo path."
    };
  }
};

const resolveCatalogEnvironment = (
  catalog: EnvironmentCatalogResult,
  value?: string
) => {
  const normalized = normalizeSupportedEnvironment(value);
  if (!normalized) {
    return undefined;
  }

  return catalog.environments.some((environment) => environment.value === normalized)
    ? normalized
    : undefined;
};

const hasEnvironment = (catalog: EnvironmentCatalogResult, value?: string) =>
  Boolean(resolveCatalogEnvironment(catalog, value));

const resolveProviderSelection = (
  providerCatalog: ProviderCatalogResult,
  aiProvider: z.infer<typeof AIProviderSchema>,
  requestedBackend?: ProviderBackend
) => {
  const provider = providerCatalog.providers.find((item) => item.id === aiProvider);

  if (!provider || !provider.available) {
    return {
      ok: false as const,
      message: `The ${aiProvider} provider is not currently available on this machine.`,
      details: provider?.warnings ?? []
    };
  }

  const providerBackend = requestedBackend ?? provider.defaultBackend;
  if (!providerBackend || !provider.availableBackends.includes(providerBackend)) {
    return {
      ok: false as const,
      message: `The ${aiProvider} provider does not have a usable backend right now.`,
      details: provider.warnings
    };
  }

  return {
    ok: true as const,
    provider,
    providerBackend
  };
};

const getEffectiveOnboardingStep = (
  config: AppConfig,
  providerCatalog: ProviderCatalogResult
) => {
  if (!config.aiProvider || !config.providerBackend) {
    return getOnboardingStep(config);
  }

  const provider = providerCatalog.providers.find((item) => item.id === config.aiProvider);
  if (!provider?.availableBackends.includes(config.providerBackend)) {
    return "provider" as const;
  }

  return getOnboardingStep(config);
};

const SUPPRESSED_WARNING_PREFIXES = [
  "Environment variants are defined in multiple forms:",
  "CI-only environments were discovered outside the typed enum:"
] as const;

const isSuppressedUnavailableProvidersWarning = (warning: string) => {
  const prefix = "Unavailable providers were detected and will stay disabled:";
  if (!warning.startsWith(prefix)) {
    return false;
  }

  const providerList = warning
    .slice(prefix.length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return providerList.length === 1 && providerList[0] === "cursor";
};

const isSuppressedCatalogWarning = (warning: string) =>
  SUPPRESSED_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix)) ||
  isSuppressedUnavailableProvidersWarning(warning);

const buildWarnings = ({
  config,
  environmentCatalog,
  providerCatalog
}: {
  config: AppConfig;
  environmentCatalog: EnvironmentCatalogResult;
  providerCatalog: ProviderCatalogResult;
}) => {
  const warnings = new Set<string>([
    ...providerCatalog.warnings.filter((warning) => !isSuppressedCatalogWarning(warning)),
    ...environmentCatalog.warnings.filter((warning) => !isSuppressedCatalogWarning(warning))
  ]);

  if (config.aiProvider && config.providerBackend) {
    const provider = providerCatalog.providers.find((item) => item.id === config.aiProvider);
    if (!provider?.availableBackends.includes(config.providerBackend)) {
      warnings.add(
        `Saved provider configuration ${config.aiProvider}/${config.providerBackend} is no longer available.`
      );
    }
  }

  if (
    config.automationRepoPath &&
    environmentCatalog.environments.length === 0 &&
    environmentCatalog.warnings.length === 0
  ) {
    warnings.add(
      "No environments were discovered in the selected automation repo. Check that the expected source files exist."
    );
  }

  if (config.lastEnvironment && !hasEnvironment(environmentCatalog, config.lastEnvironment)) {
    warnings.add(
      `Saved environment ${config.lastEnvironment} is not defined in the selected automation repo.`
    );
  }

  return [...warnings].sort();
};

const getRetainedEnvironment = (
  config: AppConfig,
  environmentCatalog: EnvironmentCatalogResult
) => resolveCatalogEnvironment(environmentCatalog, config.lastEnvironment);

export const buildApp = async ({ configDir, webRoot, services = {} }: BuildAppOptions = {}) => {
  const app = Fastify({ logger: false });
  const configStore = createConfigStore({ configDir });
  const runHistoryStore = createRunHistoryStore({ configDir });
  const environmentCatalogBuilder = services.buildEnvironmentCatalog ?? buildEnvironmentCatalog;
  const providerCatalogBuilder = services.buildProviderCatalog ?? buildProviderCatalog;
  const providerExecutor = services.executeProviderPrompt ?? executeProviderPrompt;
  const userGenerationExecutor = services.executeUserGeneration ?? executeUserGeneration;
  const runQueue = createSerialQueue();

  const getSnapshot = async (): Promise<ConfigResponse> => {
    const loadResult = await configStore.load();
    const [providerCatalog, environmentCatalog] = await Promise.all([
      providerCatalogBuilder(),
      environmentCatalogBuilder(loadResult.config.automationRepoPath)
    ]);
    const normalizedLastEnvironment = resolveCatalogEnvironment(
      environmentCatalog,
      loadResult.config.lastEnvironment
    );
    const normalizedConfig = {
      ...loadResult.config,
      lastEnvironment: normalizedLastEnvironment
    };

    return {
      config: AppConfigSchema.parse(normalizedConfig),
      configFile: loadResult.configFile,
      environments: environmentCatalog.environments,
      onboardingStep: getEffectiveOnboardingStep(normalizedConfig, providerCatalog),
      providers: providerCatalog.providers,
      recoveredFromCorruption: loadResult.recoveredFromCorruption,
      warnings: buildWarnings({
        config: normalizedConfig,
        environmentCatalog,
        providerCatalog
      })
    };
  };

  app.get("/api/config", async () => getSnapshot());

  app.get("/api/run-history", async (): Promise<RunHistoryResponse> => ({
    maxEntries: runHistoryStore.maxEntries,
    entries: await runHistoryStore.load()
  }));

  app.post("/api/config/provider", async (request, reply) => {
    const parsedBody = ProviderBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      reply.code(400);
      return errorResponse("Please choose a supported AI provider.");
    }

    const providerCatalog = await providerCatalogBuilder();
    const resolvedProvider = resolveProviderSelection(
      providerCatalog,
      parsedBody.data.aiProvider,
      parsedBody.data.providerBackend
    );

    if (!resolvedProvider.ok) {
      reply.code(400);
      return errorResponse(resolvedProvider.message, resolvedProvider.details);
    }

    await configStore.update({
      aiProvider: parsedBody.data.aiProvider,
      providerBackend: resolvedProvider.providerBackend
    });

    return getSnapshot();
  });

  app.post("/api/config/automation-repo", async (request, reply) => {
    const parsedBody = RepoBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      reply.code(400);
      return errorResponse(parsedBody.error.issues[0]?.message ?? "Invalid automation repo path.");
    }

    const validation = await validateAutomationRepoPath(parsedBody.data.automationRepoPath);

    if (!validation.ok) {
      reply.code(400);
      return errorResponse(validation.message);
    }

    const loadResult = await configStore.load();
    const environmentCatalog = await environmentCatalogBuilder(validation.normalizedPath);

    await configStore.update({
      automationRepoPath: validation.normalizedPath,
      lastEnvironment: getRetainedEnvironment(loadResult.config, environmentCatalog)
    });

    return getSnapshot();
  });

  app.post("/api/config/settings", async (request, reply) => {
    const parsedBody = SettingsBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      reply.code(400);
      return errorResponse(parsedBody.error.issues[0]?.message ?? "Invalid settings payload.");
    }

    const validation = await validateAutomationRepoPath(parsedBody.data.automationRepoPath);

    if (!validation.ok) {
      reply.code(400);
      return errorResponse(validation.message);
    }

    const providerCatalog = await providerCatalogBuilder();
    const resolvedProvider = resolveProviderSelection(
      providerCatalog,
      parsedBody.data.aiProvider,
      parsedBody.data.providerBackend
    );

    if (!resolvedProvider.ok) {
      reply.code(400);
      return errorResponse(resolvedProvider.message, resolvedProvider.details);
    }

    const loadResult = await configStore.load();
    const environmentCatalog = await environmentCatalogBuilder(validation.normalizedPath);

    await configStore.save({
      ...loadResult.config,
      aiProvider: parsedBody.data.aiProvider,
      providerBackend: resolvedProvider.providerBackend,
      automationRepoPath: validation.normalizedPath,
      lastEnvironment: getRetainedEnvironment(loadResult.config, environmentCatalog)
    });

    return getSnapshot();
  });

  app.post("/api/config/environment", async (request, reply) => {
    const parsedBody = EnvironmentBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      reply.code(400);
      return errorResponse("Please choose a supported environment.");
    }

    const loadResult = await configStore.load();
    if (!loadResult.config.automationRepoPath) {
      reply.code(400);
      return errorResponse("Save an automation repo path before choosing an environment.");
    }

    const environmentCatalog = await environmentCatalogBuilder(loadResult.config.automationRepoPath);
    const selectedEnvironment = resolveCatalogEnvironment(
      environmentCatalog,
      parsedBody.data.environment
    );
    if (!selectedEnvironment) {
      reply.code(400);
      return errorResponse(
        "Please choose a supported environment defined in the selected automation repo."
      );
    }

    await configStore.update({
      lastEnvironment: selectedEnvironment
    });

    return getSnapshot();
  });

  app.post("/api/provider/execute", async (request, reply) => {
    const parsedBody = ProviderExecutionBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      reply.code(400);
      return errorResponse(parsedBody.error.issues[0]?.message ?? "Invalid execution payload.");
    }

    const loadResult = await configStore.load();
    const { aiProvider, automationRepoPath, providerBackend } = loadResult.config;

    if (!aiProvider || !providerBackend || !automationRepoPath) {
      reply.code(400);
      return errorResponse(
        "Choose an available provider and automation repo before executing provider requests."
      );
    }

    const environmentCatalog = await environmentCatalogBuilder(automationRepoPath);
    const requestedEnvironment = parsedBody.data.environment ?? loadResult.config.lastEnvironment;
    const environment = resolveCatalogEnvironment(environmentCatalog, requestedEnvironment);

    if (!environment) {
      reply.code(400);
      return errorResponse("Choose an environment before executing provider requests.");
    }

    try {
      const result = await providerExecutor({
        backend: providerBackend,
        environment,
        prompt: parsedBody.data.prompt,
        provider: aiProvider,
        repositoryPath: automationRepoPath
      });

      return {
        backend: providerBackend,
        environment,
        output: result.output,
        prompt: parsedBody.data.prompt,
        provider: aiProvider,
        warnings: result.warnings
      };
    } catch (error) {
      reply.code(500);
      return errorResponse(
        error instanceof Error ? error.message : "Provider execution failed unexpectedly."
      );
    }
  });

  app.post("/api/run", async (request, reply) => {
    const parsedBody = UserGenerationBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      reply.code(400);
      return errorResponse(parsedBody.error.issues[0]?.message ?? "Invalid user generation payload.");
    }

    const loadResult = await configStore.load();
    const { automationRepoPath, lastEnvironment } = loadResult.config;

    if (!automationRepoPath) {
      reply.code(400);
      return errorResponse(
        "Save an automation repo path before running user generation."
      );
    }

    const environment = parsedBody.data.environment ?? lastEnvironment;

    if (!environment) {
      reply.code(400);
      return errorResponse("Choose an environment before running user generation.");
    }

    const environmentCatalog = await environmentCatalogBuilder(automationRepoPath);

    const normalizedEnvironment = resolveCatalogEnvironment(environmentCatalog, environment);

    if (!normalizedEnvironment) {
      reply.code(400);
      return errorResponse(
        "The selected environment is not defined in the current automation repo."
      );
    }

    const trustUnknown = parsedBody.data.trustUnknown ?? true;
    const trustUncertainTeardown = parsedBody.data.trustUncertainTeardown ?? true;
    const enableRcpMock = parsedBody.data.enableRcpMock ?? false;
    const keepSandbox = parsedBody.data.keepSandbox ?? false;
    const reindex = parsedBody.data.reindex ?? false;

    try {
      const payload = await runQueue(() =>
        userGenerationExecutor({
          prompt: parsedBody.data.prompt,
          spec: parsedBody.data.spec,
          test: parsedBody.data.test,
          environment: normalizedEnvironment,
          enableRcpMock,
          trustUnknown,
          trustUncertainTeardown,
          keepSandbox,
          reindex
        })
      );

      const response: UserGenerationResponse = {
        fingerprint: payload.fingerprint,
        compatibility: payload.compatibility,
        selectedTest: payload.selectedTest,
        environment: payload.environment,
        confidence: payload.confidence,
        removedCalls: payload.removedCalls,
        sandboxPath: payload.sandboxPath,
        credentials: payload.credentials,
        warnings: payload.warnings
      };

      const historyEntry: RunHistoryEntry = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        request: {
          prompt: parsedBody.data.prompt,
          spec: parsedBody.data.spec,
          test: parsedBody.data.test,
          environment: normalizedEnvironment,
          enableRcpMock,
          trustUnknown,
          trustUncertainTeardown,
          keepSandbox,
          reindex
        },
        result: {
          fingerprint: response.fingerprint,
          compatibility: response.compatibility,
          selectedTest: response.selectedTest,
          environment: response.environment,
          confidence: response.confidence,
          sandboxPath: response.sandboxPath,
          credentials: response.credentials,
          warnings: response.warnings
        }
      };

      try {
        await runHistoryStore.append(historyEntry);
      } catch {
        response.warnings = [...response.warnings, "Run history could not be persisted."];
      }

      return response;
    } catch (error) {
      const logFilePath = getLogFilePath();

      if (isTugError(error)) {
        const status = statusForReason(error.reason);
        reply.code(status);
        const body: UserGenerationError = {
          message: error.message,
          reason: error.reason,
          resolvable: RESOLVABLE_REASONS.has(error.reason),
          ...(error.details.length > 0 ? { details: error.details } : {}),
          ...(logFilePath ? { logFile: logFilePath } : {})
        };
        return body;
      }

      reply.code(500);
      return {
        ...errorResponse(error instanceof Error ? error.message : "User generation failed unexpectedly."),
        ...(logFilePath ? { logFile: logFilePath } : {})
      };
    }
  });

  app.post("/api/config/reset", async () => {
    await configStore.reset();
    return getSnapshot();
  });

  if (webRoot) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/"
    });
  }

  return app;
};
