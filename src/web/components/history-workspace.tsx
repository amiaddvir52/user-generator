import React from "react";

import type { RunHistoryEntry } from "../../shared/contracts.js";
import { CREDENTIAL_FIELD_LABELS, CREDENTIAL_FIELD_ORDER } from "../lib/constants.js";
import { Banner, Button, Card, InlineCode, SectionHeading, StatusBadge } from "./primitives.js";

type HistoryWorkspaceProps = {
  historyEntries: RunHistoryEntry[];
  historyError: string | null;
  isGenerating: boolean;
  isLoadingHistory: boolean;
  onRerunEntry: (entry: RunHistoryEntry) => void;
  onRerunLatest: () => void;
};

const formatTimestamp = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
};

const getPromptSummary = (entry: RunHistoryEntry) => {
  if (entry.request.prompt) {
    return entry.request.prompt;
  }

  if (entry.request.spec && entry.request.test) {
    return `${entry.request.test} (${entry.request.spec})`;
  }

  return "Prompt not available.";
};

const getCredentialEntries = (entry: RunHistoryEntry) =>
  [
    ...CREDENTIAL_FIELD_ORDER.map((key) => [key, entry.result.credentials[key]] as const),
    ...Object.entries(entry.result.credentials).filter(([key]) => !CREDENTIAL_FIELD_ORDER.includes(key))
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);

export const HistoryWorkspace = ({
  historyEntries,
  historyError,
  isGenerating,
  isLoadingHistory,
  onRerunEntry,
  onRerunLatest
}: HistoryWorkspaceProps) => (
  <div className="workspace-stack">
    <Card>
      <SectionHeading
        eyebrow="History"
        title="Historical Runs"
        description="Review successful user-generation runs and create another one from an existing request."
        action={
          <Button
            disabled={isGenerating || isLoadingHistory || historyEntries.length === 0}
            onClick={onRerunLatest}
            size="sm"
          >
            Create another one
          </Button>
        }
      />

      {isLoadingHistory && <p className="helper-text">Loading historical runs...</p>}
      {historyError && <Banner tone="error">{historyError}</Banner>}

      {!isLoadingHistory && !historyError && historyEntries.length === 0 && (
        <p className="helper-text">No successful runs yet. Generate a user in Runtime to populate this history.</p>
      )}

      {!isLoadingHistory && !historyError && historyEntries.length > 0 && (
        <div className="history-list">
          {historyEntries.map((entry) => {
            const credentialEntries = getCredentialEntries(entry);
            return (
              <article className="history-card" key={entry.id}>
                <div className="history-card-head">
                  <div>
                    <p className="history-timestamp">{formatTimestamp(entry.createdAt)}</p>
                    <p className="history-summary">{getPromptSummary(entry)}</p>
                  </div>
                  <div className="action-row">
                    <Button disabled={isGenerating} onClick={() => onRerunEntry(entry)} size="sm" tone="secondary">
                      Run again
                    </Button>
                  </div>
                </div>

                <div className="result-meta">
                  <StatusBadge tone="neutral">{entry.result.selectedTest.title}</StatusBadge>
                  <StatusBadge tone="neutral">{entry.request.environment}</StatusBadge>
                  <StatusBadge tone={entry.result.compatibility === "supported" ? "success" : "warning"}>
                    {entry.result.compatibility}
                  </StatusBadge>
                  <StatusBadge tone="neutral">confidence {entry.result.confidence.toFixed(2)}</StatusBadge>
                </div>

                <p className="helper-text">Source: {entry.result.selectedTest.filePath}</p>
                <p className="helper-text">Sandbox: {entry.result.sandboxPath}</p>

                {credentialEntries.length === 0 ? (
                  <p className="helper-text">No credential fields were captured for this run.</p>
                ) : (
                  <dl className="credential-table history-credentials">
                    {credentialEntries.map(([key, value]) => (
                      <div className="credential-row" key={`${entry.id}-${key}`}>
                        <dt>{CREDENTIAL_FIELD_LABELS[key] ?? key}</dt>
                        <dd>
                          <InlineCode>{value}</InlineCode>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Card>
  </div>
);
