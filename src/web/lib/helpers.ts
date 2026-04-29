import type { AIProvider, OnboardingStep } from "../../shared/config.js";
import type {
  ConfigResponse,
  EnvironmentOption,
  ProviderOption,
  UserGenerationCredentials,
  UserGenerationError
} from "../../shared/contracts.js";
import type { AppSection, LegacyView } from "./types.js";

export const toExportEnvLines = (credentials: UserGenerationCredentials) =>
  Object.entries(credentials)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => {
      const envKey = `TUG_${key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
      const escaped = value.replace(/'/g, "'\\''");
      return `export ${envKey}='${escaped}'`;
    });

export const downloadJson = (payload: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export const describeConfirmation = (error: UserGenerationError): string => {
  switch (error.reason) {
    case "CANDIDATE_AMBIGUOUS":
      return "Multiple tests matched that prompt. Pick the one you want below.";
    case "FINGERPRINT_UNKNOWN":
      return "This automation repo fingerprint is not in the known-compatibility list yet.";
    case "TEARDOWN_IDENTITY_UNSURE":
      return "Some identifiers in teardown hooks could not be classified with high confidence.";
    case "TEARDOWN_HOOK_HAS_UNKNOWN_CALL":
      return "A teardown hook contains calls that were not classified as teardown.";
    case "WORKING_TREE_DIRTY":
      return "The automation repo has uncommitted changes.";
    case "PLAYWRIGHT_INCOMPATIBLE":
      return "The repo's Playwright version is outside the supported window.";
    default:
      return error.message;
  }
};

export const formatProviderWarnings = (provider: ProviderOption) =>
  [...provider.warnings, ...(provider.reason ? [provider.reason] : [])];

export const chooseInitialProvider = (state: ConfigResponse): AIProvider =>
  state.config.aiProvider ??
  state.providers.find((provider) => provider.available)?.id ??
  state.providers[0]?.id ??
  "codex";

export const chooseInitialEnvironment = (state: ConfigResponse) =>
  state.config.lastEnvironment ?? state.environments[0]?.value ?? "";

const chooseInitialView = (state: ConfigResponse, preferredView?: LegacyView): LegacyView => {
  if (preferredView) {
    return preferredView;
  }

  if (
    state.onboardingStep === "environment" &&
    state.config.lastEnvironment &&
    state.environments.some((environment) => environment.value === state.config.lastEnvironment)
  ) {
    return "ready";
  }

  return state.onboardingStep;
};

export const chooseInitialSection = (
  state: ConfigResponse,
  preferredView?: LegacyView,
  currentSection?: AppSection
): AppSection => {
  if (preferredView === "settings") {
    return "settings";
  }

  if (currentSection === "settings" && !preferredView) {
    return "settings";
  }

  const view = chooseInitialView(state, preferredView);
  if (view === "ready") {
    return "runtime";
  }

  return "setup";
};

export const summarizeSources = (environment: EnvironmentOption) => {
  if (environment.sources.length === 0) {
    return "No source references captured.";
  }

  const [firstSource, ...remainingSources] = environment.sources;
  if (remainingSources.length === 0) {
    return firstSource;
  }

  return `${firstSource} + ${remainingSources.length} more`;
};

export const formatElapsedTime = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const describeGenerationProgress = (
  elapsedSeconds: number,
  enableRcpMock: boolean
): string => {
  if (enableRcpMock && elapsedSeconds < 12) {
    return "Triggering RCP mock workflow and waiting for it to complete.";
  }
  if (elapsedSeconds < 4) {
    return "Preparing sandbox and validating the selected environment.";
  }
  if (elapsedSeconds < 12) {
    return "Finding the best matching Playwright test for your prompt.";
  }
  if (elapsedSeconds < 30) {
    return "Running the selected test and waiting for credentials.";
  }
  return "Still running: finishing execution and collecting generated fields.";
};

export const completionForStep = (
  step: OnboardingStep,
  config: ConfigResponse["config"],
  environments: ConfigResponse["environments"]
): boolean => {
  if (step === "provider") {
    return Boolean(config.aiProvider && config.providerBackend);
  }

  if (step === "automationRepo") {
    return Boolean(config.automationRepoPath);
  }

  return Boolean(
    config.lastEnvironment &&
      environments.some((environment) => environment.value === config.lastEnvironment)
  );
};
