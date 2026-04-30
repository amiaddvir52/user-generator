import type { AIProvider, ProviderBackend } from "../../shared/config.js";

export type OutputMode = "text" | "json";
export type ExecutionMode = "fast" | "full";

export type ReasonCode =
  | "PATH_INVALID"
  | "PATH_NOT_GIT_REPO"
  | "STRUCTURE_INVALID"
  | "FINGERPRINT_UNKNOWN"
  | "PLAYWRIGHT_INCOMPATIBLE"
  | "WORKING_TREE_DIRTY"
  | "VALIDATION_FAILED"
  | "TEARDOWN_IDENTITY_UNSURE"
  | "TEARDOWN_HOOK_HAS_UNKNOWN_CALL"
  | "TRANSFORM_INCOMPLETE"
  | "CANDIDATE_AMBIGUOUS"
  | "SERIAL_DEPENDENCY"
  | "CREDENTIAL_MARKER_MISSING"
  | "ENV_INCOMPLETE"
  | "CONFIG_INCOMPLETE"
  | "SANDBOX_COLLISION"
  | "EXECUTION_FAILED"
  | "UNKNOWN_ERROR";

export type RepoHandle = {
  absPath: string;
  smRootPath: string;
  packageName: string;
  packageVersion: string;
  playwrightConfigPath: string;
  tsconfigPath: string;
  lockfilePath?: string;
  packageManagerCommand?: string[];
  gitSha: string;
  isDirty: boolean;
};

export type FingerprintInfo = {
  fingerprint: string;
  helperFiles: string[];
  helperExports: Record<string, string[]>;
  packageName: string;
  packageVersion: string;
  playwrightMajor?: number;
  typescriptMajor?: number;
  hashInputs: Record<string, unknown>;
};

export type CompatibilityStatus = "supported" | "experimental";

export type CompatibilityResult = {
  status: CompatibilityStatus;
  fingerprint: string;
  notes?: string;
  knownTeardownHints: string[];
};

export type TeardownScore = {
  identifier: string;
  score: number;
  pHook: number;
  pName: number;
  pTrans: number;
  pOrigin: number;
};

export type TeardownDetectionResult = {
  confirmed: string[];
  suspected: string[];
  scores: TeardownScore[];
  observedHookCalls: string[];
};

export type ScoreHints = {
  payerLocation?: string;
  contractType?: string;
};

export type SpecIndexEntry = {
  filePath: string;
  testTitle: string;
  describeTitles: string[];
  tags: string[];
  helperImports: string[];
  teardownCalls: string[];
  scoreHints: ScoreHints;
};

export type IndexData = {
  fingerprint: string;
  generatedAt: string;
  entries: SpecIndexEntry[];
  teardown: TeardownDetectionResult;
};

export type Intent = {
  rawPrompt: string;
  keywords: string[];
  hints: ScoreHints;
};

export type RankedCandidate = {
  entry: SpecIndexEntry;
  score: number;
  reasons: string[];
};

export type SelectionResult = {
  selected: RankedCandidate;
  ranked: RankedCandidate[];
  ambiguous: boolean;
  margin: number;
};

export type RemovedCallsite = {
  identifier: string;
  line: number;
  kind: "hook" | "body";
  score: number;
};

export type TransformResult = {
  transformedText: string;
  originalText: string;
  selectedTitle: string;
  sourceFile: string;
  removedCalls: RemovedCallsite[];
  confidence: number;
  unknownHookCalls: string[];
  uncertainIdentifiers: string[];
};

export type SandboxHandle = {
  path: string;
  specPath: string;
  playwrightConfigPath: string;
  tsconfigPath: string;
  diffPath: string;
  runPlanPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
};

export type RunContext = {
  repoPath: string;
  provider?: AIProvider;
  providerBackend?: ProviderBackend;
  environment?: string;
  configFile: string;
  sources: {
    repoPath: "cli" | "env" | "config";
    provider: "cli" | "env" | "config" | "unset";
    providerBackend: "cli" | "env" | "config" | "unset";
    environment: "cli" | "env" | "config" | "unset";
  };
};

export type CredentialPayload = {
  email?: string;
  password?: string;
  accountId?: string;
  smAccountId?: string;
  marketplaceId?: string;
  subscriptionId?: string;
  databaseId?: string;
  [key: string]: string | undefined;
};

export type CredentialSnapshotPhase = "entry" | "fast-early-return" | "final";

export type CredentialSnapshotEvent = {
  phase: CredentialSnapshotPhase;
  line?: number;
  credentials: CredentialPayload;
};

export type ProvisioningState = "complete" | "partial";

export type GeneratedAccount = {
  id: string;
  fields: CredentialPayload;
  sourcePhases: CredentialSnapshotPhase[];
  provisioningState: ProvisioningState;
  usable: boolean;
};

export type GeneratedAccounts = {
  target: GeneratedAccount | null;
  secondary: GeneratedAccount[];
};

export type RunState = {
  completedFullFlow: boolean;
  partial: boolean;
  exitPhase?: CredentialSnapshotPhase;
  exitLine?: number;
};

export type RunTiming = {
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

export type CommandResult = {
  ok: true;
  data: Record<string, unknown>;
} | {
  ok: false;
  reason: ReasonCode;
  message: string;
  details?: string[];
};
