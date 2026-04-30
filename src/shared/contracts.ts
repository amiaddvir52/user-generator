import type { AIProvider, AppConfig, OnboardingStep, ProviderBackend } from "./config.js";

export type EnvironmentCategory = "enum" | "alias" | "helper" | "ci-only";

export type ProviderOption = {
  id: AIProvider;
  label: string;
  available: boolean;
  availableBackends: ProviderBackend[];
  defaultBackend?: ProviderBackend;
  warnings: string[];
  reason?: string;
};

export type EnvironmentOption = {
  value: string;
  category: EnvironmentCategory;
  normalizedValue?: string;
  sources: string[];
  warnings: string[];
};

export type ConfigResponse = {
  config: AppConfig;
  configFile: string;
  environments: EnvironmentOption[];
  onboardingStep: OnboardingStep;
  providers: ProviderOption[];
  recoveredFromCorruption: boolean;
  warnings: string[];
};

export type ApiError = {
  message: string;
  details?: string[];
  logFile?: string;
};

export type ProviderExecutionResponse = {
  backend: ProviderBackend;
  environment: string;
  output: string;
  prompt: string;
  provider: AIProvider;
  warnings: string[];
};

export type UserGenerationCredentials = {
  email?: string;
  password?: string;
  accountId?: string;
  smAccountId?: string;
  marketplaceId?: string;
  subscriptionId?: string;
  databaseId?: string;
  [key: string]: string | undefined;
};

export type UserGenerationSnapshotPhase = "entry" | "fast-early-return" | "final";
export type UserGenerationProvisioningState = "complete" | "partial";

export type UserGenerationAccount = {
  id: string;
  fields: UserGenerationCredentials;
  sourcePhases: UserGenerationSnapshotPhase[];
  provisioningState: UserGenerationProvisioningState;
  usable: boolean;
};

export type UserGenerationAccounts = {
  target: UserGenerationAccount | null;
  secondary: UserGenerationAccount[];
};

export type UserGenerationRunState = {
  completedFullFlow: boolean;
  partial: boolean;
  exitPhase?: UserGenerationSnapshotPhase;
  exitLine?: number;
};

export type UserGenerationTiming = {
  selectionMs: number;
  transformMs: number;
  executeMs: number;
  totalMs: number;
  preflightMs?: number;
  indexMs?: number;
  sandboxBuildMs?: number;
  sandboxValidationMs?: number;
  cleanupMs?: number;
  fallbackMs?: number;
  repoListCacheHit?: boolean;
  sandboxValidationCacheHit?: boolean;
};

export type ExecutionMode = "fast" | "full";

export type UserGenerationRemovedCall = {
  identifier: string;
  line: number;
  kind: "hook" | "body";
  score: number;
};

export type UserGenerationResponse = {
  fingerprint: string;
  compatibility: "supported" | "experimental";
  selectedTest: {
    filePath: string;
    title: string;
  };
  environment: string;
  executionMode: ExecutionMode;
  fallbackTriggered: boolean;
  confidence: number;
  removedCalls: UserGenerationRemovedCall[];
  sandboxPath: string;
  accounts: UserGenerationAccounts;
  runState: UserGenerationRunState;
  timing?: UserGenerationTiming;
  fastPathTriggered?: boolean;
  warnings: string[];
};

export type UserGenerationErrorReason =
  | "CANDIDATE_AMBIGUOUS"
  | "FINGERPRINT_UNKNOWN"
  | "TEARDOWN_IDENTITY_UNSURE"
  | "TEARDOWN_HOOK_HAS_UNKNOWN_CALL"
  | "WORKING_TREE_DIRTY"
  | "PLAYWRIGHT_INCOMPATIBLE";

export type UserGenerationError = ApiError & {
  reason?: UserGenerationErrorReason | string;
  resolvable?: boolean;
};

export type RunHistoryRequestSnapshot = {
  prompt?: string;
  spec?: string;
  test?: string;
  environment: string;
  executionMode: ExecutionMode;
  allowAutoFallback: boolean;
  enableRcpMock: boolean;
  trustUnknown: boolean;
  trustUncertainTeardown: boolean;
  keepSandbox: boolean;
  reindex: boolean;
};

export type RunHistoryResultSnapshot = Pick<
  UserGenerationResponse,
  | "fingerprint"
  | "compatibility"
  | "selectedTest"
  | "environment"
  | "executionMode"
  | "fallbackTriggered"
  | "confidence"
  | "sandboxPath"
  | "accounts"
  | "runState"
  | "timing"
  | "fastPathTriggered"
  | "warnings"
>;

export type RunHistoryEntry = {
  id: string;
  createdAt: string;
  request: RunHistoryRequestSnapshot;
  result: RunHistoryResultSnapshot;
};

export type RunHistoryResponse = {
  maxEntries: number;
  entries: RunHistoryEntry[];
};
