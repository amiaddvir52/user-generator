import { z } from "zod";

export const APP_NAME = "user-generator";
export const CONFIG_VERSION = 2;

export const AI_PROVIDERS = ["augment", "codex", "cursor"] as const;
export const PROVIDER_BACKENDS = ["augment-sdk", "augment-auggie", "codex-cli"] as const;
export const LEGACY_ENVIRONMENTS = ["dev", "staging"] as const;

export const AIProviderSchema = z.enum(AI_PROVIDERS);
export const ProviderBackendSchema = z.enum(PROVIDER_BACKENDS);

export const AppConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  aiProvider: AIProviderSchema.optional(),
  providerBackend: ProviderBackendSchema.optional(),
  automationRepoPath: z.string().min(1).optional(),
  lastEnvironment: z.string().min(1).optional()
});

const LegacyAppConfigSchema = z.object({
  version: z.literal(1),
  aiProvider: AIProviderSchema.optional(),
  automationRepoPath: z.string().min(1).optional(),
  lastEnvironment: z.enum(LEGACY_ENVIRONMENTS).optional()
});

const PersistedAppConfigSchema = z.union([AppConfigSchema, LegacyAppConfigSchema]);

export type AIProvider = z.infer<typeof AIProviderSchema>;
export type ProviderBackend = z.infer<typeof ProviderBackendSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
type LegacyAppConfig = z.infer<typeof LegacyAppConfigSchema>;

export type OnboardingStep = "provider" | "automationRepo" | "environment";

export const LEGACY_ENVIRONMENT_MAP = {
  dev: "qa.qa",
  staging: "staging.qa"
} as const;

export const createEmptyConfig = (): AppConfig => ({
  version: CONFIG_VERSION
});

export const getOnboardingStep = (config: AppConfig): OnboardingStep => {
  if (!config.aiProvider || !config.providerBackend) {
    return "provider";
  }

  if (!config.automationRepoPath) {
    return "automationRepo";
  }

  return "environment";
};

const migrateLegacyConfig = (config: LegacyAppConfig): AppConfig => ({
  version: CONFIG_VERSION,
  aiProvider: config.aiProvider,
  automationRepoPath: config.automationRepoPath,
  lastEnvironment: config.lastEnvironment
    ? LEGACY_ENVIRONMENT_MAP[config.lastEnvironment]
    : undefined
});

export const parsePersistedConfig = (value: unknown): AppConfig => {
  const parsed = PersistedAppConfigSchema.parse(value);
  if (parsed.version === 1) {
    return migrateLegacyConfig(parsed);
  }

  return parsed;
};
