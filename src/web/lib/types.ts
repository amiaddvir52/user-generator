import type { OnboardingStep } from "../../shared/config.js";
import type { UserGenerationError } from "../../shared/contracts.js";

export type AppSection = "setup" | "runtime" | "history" | "settings";
export type LegacyView = OnboardingStep | "ready" | "settings";

export type UserGenerationRequest = {
  prompt?: string;
  spec?: string;
  test?: string;
  environment?: string;
  enableRcpMock?: boolean;
  trustUnknown?: boolean;
  trustUncertainTeardown?: boolean;
  keepSandbox?: boolean;
  reindex?: boolean;
};

export type PendingConfirmation = {
  error: UserGenerationError;
  baseRequest: UserGenerationRequest;
};

export type GenerationErrorState = {
  message: string;
  details?: string[];
  logFile?: string;
};
