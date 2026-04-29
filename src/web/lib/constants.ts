import type { UserGenerationRequest } from "./types.js";

export const DEFAULT_EXECUTION_PROMPT =
  "Confirm that the selected provider can access this automation repo and explain how you would use the chosen environment in the next phase.";

export const DEFAULT_USER_GENERATION_PROMPT = "US account with on-demand contract";

export const DEFAULT_GENERATION_OVERRIDES: Pick<
  UserGenerationRequest,
  "trustUnknown" | "trustUncertainTeardown"
> = {
  trustUnknown: true,
  trustUncertainTeardown: true
};

export const CREDENTIAL_FIELD_LABELS: Record<string, string> = {
  email: "Email",
  password: "Password",
  accountId: "Account ID",
  smAccountId: "SM Account ID",
  marketplaceId: "Marketplace ID",
  subscriptionId: "Subscription ID",
  databaseId: "Database ID"
};

export const CREDENTIAL_FIELD_ORDER = [
  "email",
  "password",
  "accountId",
  "smAccountId",
  "marketplaceId",
  "subscriptionId",
  "databaseId"
];
