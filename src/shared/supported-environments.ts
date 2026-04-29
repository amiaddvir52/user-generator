export const SUPPORTED_ENVIRONMENTS = [
  "k8s-integration",
  "k8s-billing",
  "k8s-billing-dev",
  "auto",
  "qa.qa"
] as const;

export type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

export const SUPPORTED_ENVIRONMENT_RUNTIME_MAP: Record<SupportedEnvironment, string> = {
  "k8s-integration": "sm.k8s-integration.sm-qa.qa",
  "k8s-billing": "sm.k8s-billing.sm-qa.qa",
  "k8s-billing-dev": "sm.k8s-billing-dev.sm-qa.qa",
  auto: "sm.k8s-auto.sm-qa.qa",
  "qa.qa": "qa.qa"
};

const SUPPORTED_ENVIRONMENT_CANONICAL_BY_VARIANT = SUPPORTED_ENVIRONMENTS.reduce<
  Record<string, SupportedEnvironment>
>((mapping, value) => {
  mapping[value] = value;
  mapping[SUPPORTED_ENVIRONMENT_RUNTIME_MAP[value]] = value;
  return mapping;
}, {});

export const normalizeSupportedEnvironment = (value?: string) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return SUPPORTED_ENVIRONMENT_CANONICAL_BY_VARIANT[trimmed];
};

export const isSupportedEnvironment = (value?: string) =>
  Boolean(normalizeSupportedEnvironment(value));

export const resolveRuntimeEnvironment = (value?: string) => {
  const normalized = normalizeSupportedEnvironment(value);
  if (!normalized) {
    return undefined;
  }

  return SUPPORTED_ENVIRONMENT_RUNTIME_MAP[normalized];
};
