import { createConfigStore } from "../../server/config-store.js";
import { AIProviderSchema, ProviderBackendSchema } from "../../shared/config.js";
import type { RunContext } from "./types.js";
import { TugError } from "./errors.js";

const normalizeProvider = (value?: string) => {
  if (!value) {
    return undefined;
  }

  const parsed = AIProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const normalizeBackend = (value?: string) => {
  if (!value) {
    return undefined;
  }

  const parsed = ProviderBackendSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export type ContextOverrides = {
  repo?: string;
  provider?: string;
  providerBackend?: string;
  environment?: string;
};

export const loadRunContext = async (overrides: ContextOverrides): Promise<RunContext> => {
  const store = createConfigStore();
  const { config, configFile } = await store.load();

  const envRepo = process.env.TUG_REPO_PATH?.trim() || undefined;
  const envProvider = process.env.TUG_PROVIDER?.trim() || undefined;
  const envBackend = process.env.TUG_PROVIDER_BACKEND?.trim() || undefined;
  const envEnvironment = process.env.TUG_ENVIRONMENT?.trim() || undefined;

  const repoPath = overrides.repo?.trim() || envRepo || config.automationRepoPath;
  if (!repoPath) {
    throw new TugError(
      "CONFIG_INCOMPLETE",
      "Repository path is required. Pass --repo, set TUG_REPO_PATH, or save it in onboarding settings."
    );
  }

  const provider = normalizeProvider(overrides.provider) ?? normalizeProvider(envProvider) ?? config.aiProvider;
  const providerBackend =
    normalizeBackend(overrides.providerBackend) ??
    normalizeBackend(envBackend) ??
    config.providerBackend;
  const environment = overrides.environment?.trim() || envEnvironment || config.lastEnvironment;

  return {
    repoPath,
    provider,
    providerBackend,
    environment,
    configFile,
    sources: {
      repoPath: overrides.repo ? "cli" : envRepo ? "env" : "config",
      provider: overrides.provider
        ? "cli"
        : envProvider
          ? "env"
          : provider
            ? "config"
            : "unset",
      providerBackend: overrides.providerBackend
        ? "cli"
        : envBackend
          ? "env"
          : providerBackend
            ? "config"
            : "unset",
      environment: overrides.environment
        ? "cli"
        : envEnvironment
          ? "env"
          : environment
            ? "config"
            : "unset"
    }
  };
};

