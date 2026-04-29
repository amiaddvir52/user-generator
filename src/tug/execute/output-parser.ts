import { CREDENTIAL_MARKER } from "../transform/credential-probe.js";
import { TugError } from "../common/errors.js";
import type {
  CredentialPayload,
  CredentialSnapshotEvent,
  CredentialSnapshotPhase,
  GeneratedAccount,
  GeneratedAccounts,
  RunState
} from "../common/types.js";
import { hasCompletePrimaryCredentials } from "./credential-completeness.js";

const PHASE_ORDER: CredentialSnapshotPhase[] = ["entry", "fast-early-return", "final"];

type MutableAccount = {
  internalId: string;
  aliases: Set<string>;
  fields: CredentialPayload;
  phases: Set<CredentialSnapshotPhase>;
  lastSeenIndex: number;
};

const isNonEmpty = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeCredentialPayload = (payload: CredentialPayload): CredentialPayload =>
  Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      typeof value === "string" ? value.trim() : value
    ]).filter((entry): entry is [string, string] => isNonEmpty(entry[1]))
  ) as CredentialPayload;

const normalizeIdentityValue = (key: string, value: string) =>
  key === "email" ? value.trim().toLowerCase() : value.trim();

const buildIdentityCandidates = (payload: CredentialPayload) => {
  const candidates: string[] = [];
  const priorityKeys = ["smAccountId", "accountId", "email", "marketplaceId", "subscriptionId", "databaseId"] as const;

  priorityKeys.forEach((key) => {
    const value = payload[key];
    if (!isNonEmpty(value)) {
      return;
    }
    candidates.push(`${key}:${normalizeIdentityValue(key, value)}`);
  });

  return candidates;
};

const resolveCanonicalAccountId = ({
  payload,
  fallbackIndex
}: {
  payload: CredentialPayload;
  fallbackIndex: number;
}) =>
  payload.smAccountId ??
  payload.accountId ??
  payload.email ??
  payload.marketplaceId ??
  payload.subscriptionId ??
  payload.databaseId ??
  `snapshot-${fallbackIndex}`;

const parseRawMarkerLine = (line: string) => {
  const markerIndex = line.indexOf(CREDENTIAL_MARKER);
  if (markerIndex === -1) {
    return undefined;
  }

  const payloadRaw = line.slice(markerIndex + CREDENTIAL_MARKER.length).trim();
  if (payloadRaw.length === 0) {
    throw new TugError(
      "CREDENTIAL_MARKER_MISSING",
      "Credential marker was found but did not include a payload.",
      [line]
    );
  }

  try {
    return JSON.parse(payloadRaw) as unknown;
  } catch {
    throw new TugError(
      "CREDENTIAL_MARKER_MISSING",
      "Credential marker was found but could not be parsed as JSON.",
      [payloadRaw]
    );
  }
};

const parseFallbackLineNumber = (line: string) => {
  const match = line.match(/:(\d+):\d+/);
  if (!match) {
    return undefined;
  }

  const lineNumber = Number(match[1]);
  return Number.isFinite(lineNumber) ? lineNumber : undefined;
};

const parseMarkerEvent = (line: string): CredentialSnapshotEvent | undefined => {
  const parsed = parseRawMarkerLine(line);
  if (!parsed) {
    return undefined;
  }

  if (typeof parsed === "object" && parsed != null && "credentials" in parsed) {
    const envelope = parsed as {
      phase?: string;
      line?: number;
      credentials?: CredentialPayload;
    };
    const phase = PHASE_ORDER.includes(envelope.phase as CredentialSnapshotPhase)
      ? (envelope.phase as CredentialSnapshotPhase)
      : "final";
    const credentials = normalizeCredentialPayload((envelope.credentials ?? {}) as CredentialPayload);
    const lineNumber = Number.isFinite(envelope.line) ? envelope.line : parseFallbackLineNumber(line);
    return {
      phase,
      line: lineNumber,
      credentials
    };
  }

  if (typeof parsed === "object" && parsed != null) {
    return {
      phase: "final",
      line: parseFallbackLineNumber(line),
      credentials: normalizeCredentialPayload(parsed as CredentialPayload)
    };
  }

  throw new TugError(
    "CREDENTIAL_MARKER_MISSING",
    "Credential marker payload did not contain a supported object envelope.",
    [line]
  );
};

const materializeAccount = (account: MutableAccount): GeneratedAccount => {
  const sourcePhases = PHASE_ORDER.filter((phase) => account.phases.has(phase));
  const provisioningState = account.phases.has("final") ? "complete" : "partial";
  const hasPrimaryCredentials = hasCompletePrimaryCredentials(account.fields);
  const usableFromFastEarlyReturn = provisioningState === "partial" && account.phases.has("fast-early-return");

  return {
    id: resolveCanonicalAccountId({
      payload: account.fields,
      fallbackIndex: account.lastSeenIndex + 1
    }),
    fields: account.fields,
    sourcePhases,
    provisioningState,
    usable: hasPrimaryCredentials && (provisioningState === "complete" || usableFromFastEarlyReturn)
  };
};

const buildRunState = (events: CredentialSnapshotEvent[]): RunState => {
  const completedFullFlow = events.some((event) => event.phase === "final");
  const partial = events.length > 0 && !completedFullFlow;
  const last = events.at(-1);

  return partial
    ? {
        completedFullFlow,
        partial,
        exitPhase: last?.phase,
        exitLine: last?.line
      }
    : {
        completedFullFlow,
        partial
      };
};

const buildAccounts = (events: CredentialSnapshotEvent[]): GeneratedAccounts => {
  const accountsById = new Map<string, MutableAccount>();
  const aliasToInternalId = new Map<string, string>();
  const eventAccountIds: string[] = [];

  events.forEach((event, index) => {
    const identities = buildIdentityCandidates(event.credentials);
    const matchedInternalId = identities.map((identity) => aliasToInternalId.get(identity)).find(Boolean);
    const internalId = matchedInternalId ?? `account-${index + 1}`;

    const mutableAccount = accountsById.get(internalId) ?? {
      internalId,
      aliases: new Set<string>(),
      fields: {},
      phases: new Set<CredentialSnapshotPhase>(),
      lastSeenIndex: index
    };

    identities.forEach((identity) => {
      mutableAccount.aliases.add(identity);
      aliasToInternalId.set(identity, internalId);
    });

    mutableAccount.fields = {
      ...mutableAccount.fields,
      ...event.credentials
    };
    mutableAccount.phases.add(event.phase);
    mutableAccount.lastSeenIndex = index;

    accountsById.set(internalId, mutableAccount);
    eventAccountIds[index] = internalId;
  });

  const lastFinalEventIndex = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.phase === "final")
    .at(-1)?.index;
  const targetInternalId =
    typeof lastFinalEventIndex === "number" ? eventAccountIds[lastFinalEventIndex] : eventAccountIds.at(-1);

  const targetAccount = targetInternalId ? materializeAccount(accountsById.get(targetInternalId)!) : null;
  const secondaryAccounts = [...accountsById.values()]
    .filter((account) => account.internalId !== targetInternalId)
    .sort((left, right) => left.lastSeenIndex - right.lastSeenIndex)
    .map((account) => materializeAccount(account));

  if (!targetAccount) {
    return {
      target: null,
      secondary: secondaryAccounts
    };
  }

  return {
    target: targetAccount,
    secondary: secondaryAccounts
  };
};

export const formatPartialRunWarning = (runState: RunState) => {
  if (!runState.partial) {
    return undefined;
  }

  const lineLabel = Number.isFinite(runState.exitLine) ? String(runState.exitLine) : "unknown";
  return `Warning: Test exited at line ${lineLabel}. Credential marker captured but provisioned state is partial/incomplete.`;
};

export const parseCredentialMarkerEvents = (lines: string[]): CredentialSnapshotEvent[] =>
  lines
    .map((line) => parseMarkerEvent(line))
    .filter((event): event is CredentialSnapshotEvent => Boolean(event));

export const parseCredentialExecution = (lines: string[]) => {
  const events = parseCredentialMarkerEvents(lines);
  if (events.length === 0) {
    throw new TugError(
      "CREDENTIAL_MARKER_MISSING",
      "Execution completed without emitting a credential marker."
    );
  }

  const runState = buildRunState(events);
  const accounts = buildAccounts(events);
  return {
    events,
    runState,
    accounts,
    warning: formatPartialRunWarning(runState)
  };
};

export const parseCredentialMarker = (lines: string[]): CredentialPayload => {
  const execution = parseCredentialExecution(lines);
  return execution.accounts.target?.fields ?? {};
};
