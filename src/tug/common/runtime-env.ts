import {
  normalizeSupportedEnvironment,
  resolveRuntimeEnvironment
} from "../../shared/supported-environments.js";

const KNOWN_CLOUD_PROVIDERS = ["aws", "gcp", "azure"] as const;

type CloudProvider = (typeof KNOWN_CLOUD_PROVIDERS)[number];

const DEFAULT_REGION_BY_PROVIDER: Record<CloudProvider, string> = {
  aws: "us-east-1",
  gcp: "us-central1",
  azure: "eastus"
};

const GCP_REGION_PATTERN = /^[a-z]+-[a-z]+[0-9]+$/;
const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-[0-9]+$/;

const normalizeCloudProvider = (value?: string): CloudProvider | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return KNOWN_CLOUD_PROVIDERS.find((provider) => provider === normalized);
};

const inferProviderFromEnvironment = (value?: string): CloudProvider | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "gcp" || normalized.includes("gcp")) {
    return "gcp";
  }

  if (normalized === "aws" || normalized.includes("aws")) {
    return "aws";
  }

  if (normalized === "azure" || normalized.includes("azure")) {
    return "azure";
  }

  return undefined;
};

const inferProviderFromRegion = (region?: string): CloudProvider | undefined => {
  if (!region) {
    return undefined;
  }

  const normalized = region.trim().toLowerCase();
  if (GCP_REGION_PATTERN.test(normalized) && !AWS_REGION_PATTERN.test(normalized)) {
    return "gcp";
  }

  if (AWS_REGION_PATTERN.test(normalized)) {
    return "aws";
  }

  return undefined;
};

export const buildExecutionEnv = ({
  baseEnv = process.env,
  environment
}: {
  baseEnv?: NodeJS.ProcessEnv;
  environment?: string;
} = {}): NodeJS.ProcessEnv => {
  const executionEnv: NodeJS.ProcessEnv = { ...baseEnv };

  const selectedEnvironment = environment?.trim() || undefined;
  const canonicalEnvironment = normalizeSupportedEnvironment(selectedEnvironment);
  const runtimeEnvironment = resolveRuntimeEnvironment(selectedEnvironment) ?? selectedEnvironment;
  if (selectedEnvironment) {
    executionEnv.TUG_ENVIRONMENT = canonicalEnvironment ?? selectedEnvironment;
    // The target automation repo reads `process.env.env` for environment routing.
    executionEnv.env = runtimeEnvironment;
  }

  const inferredProvider =
    normalizeCloudProvider(executionEnv.cloudProvider) ??
    normalizeCloudProvider(executionEnv.cloudService) ??
    normalizeCloudProvider(executionEnv.marketplace) ??
    inferProviderFromEnvironment(canonicalEnvironment) ??
    inferProviderFromEnvironment(selectedEnvironment) ??
    inferProviderFromEnvironment(runtimeEnvironment) ??
    inferProviderFromEnvironment(executionEnv.env) ??
    inferProviderFromRegion(executionEnv.region);

  if (inferredProvider) {
    if (!normalizeCloudProvider(executionEnv.cloudProvider)) {
      executionEnv.cloudProvider = inferredProvider;
    }

    if (!normalizeCloudProvider(executionEnv.cloudService)) {
      executionEnv.cloudService = inferredProvider;
    }

    if (!normalizeCloudProvider(executionEnv.marketplace)) {
      executionEnv.marketplace = inferredProvider;
    }
  }

  if (!executionEnv.region && inferredProvider) {
    executionEnv.region = DEFAULT_REGION_BY_PROVIDER[inferredProvider];
  }

  return executionEnv;
};
