import type { CredentialPayload } from "../common/types.js";

const isNonEmpty = (value: string | undefined) => typeof value === "string" && value.trim().length > 0;

export const hasCompletePrimaryCredentials = (credentials: CredentialPayload) =>
  isNonEmpty(credentials.email) && isNonEmpty(credentials.password);
