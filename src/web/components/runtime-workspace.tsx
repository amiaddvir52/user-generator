import React from "react";

import type {
  ConfigResponse,
  EnvironmentOption,
  ProviderExecutionResponse,
  UserGenerationResponse
} from "../../shared/contracts.js";
import { CREDENTIAL_FIELD_LABELS, CREDENTIAL_FIELD_ORDER } from "../lib/constants.js";
import { describeGenerationProgress, formatElapsedTime } from "../lib/helpers.js";
import type { GenerationErrorState } from "../lib/types.js";
import { Banner, Button, Card, Field, InlineCode, Label, SectionHeading, StatusBadge } from "./primitives.js";

type RuntimeWorkspaceProps = {
  configState: ConfigResponse;
  copiedField: string | null;
  enableRcpMock: boolean;
  executionPrompt: string;
  executionResult: ProviderExecutionResponse | null;
  exportEnvLines: string[];
  generationElapsedSeconds: number;
  generationError: GenerationErrorState | null;
  generationPrompt: string;
  generationResult: UserGenerationResponse | null;
  isFastMode: boolean;
  isAdvancedOpen: boolean;
  isExecuting: boolean;
  isGenerating: boolean;
  keepSandbox: boolean;
  onAdvancedOpenChange: (value: boolean) => void;
  onCopyFieldValue: (field: string, value: string) => void;
  onDownloadResult: () => void;
  onEnableRcpMockChange: (value: boolean) => void;
  onExecutePrompt: () => void;
  onFastModeChange: (value: boolean) => void;
  onGenerationPromptChange: (value: string) => void;
  onGenerateUser: () => void;
  onKeepSandboxChange: (value: boolean) => void;
  onTrustUncertainTeardownChange: (value: boolean) => void;
  onTrustUnknownChange: (value: boolean) => void;
  onExecutionPromptChange: (value: string) => void;
  selectedEnvironment: EnvironmentOption | undefined;
  trustUncertainTeardown: boolean;
  trustUnknown: boolean;
};

export const RuntimeWorkspace = ({
  configState,
  copiedField,
  enableRcpMock,
  executionPrompt,
  executionResult,
  exportEnvLines,
  generationElapsedSeconds,
  generationError,
  generationPrompt,
  generationResult,
  isFastMode,
  isAdvancedOpen,
  isExecuting,
  isGenerating,
  keepSandbox,
  onAdvancedOpenChange,
  onCopyFieldValue,
  onDownloadResult,
  onEnableRcpMockChange,
  onExecutePrompt,
  onExecutionPromptChange,
  onFastModeChange,
  onGenerationPromptChange,
  onGenerateUser,
  onKeepSandboxChange,
  onTrustUncertainTeardownChange,
  onTrustUnknownChange,
  selectedEnvironment,
  trustUncertainTeardown,
  trustUnknown
}: RuntimeWorkspaceProps) => {
  const generationStatusMessage = describeGenerationProgress(generationElapsedSeconds, enableRcpMock);

  const credentialEntries = generationResult
    ? [
        ...CREDENTIAL_FIELD_ORDER.map(
          (key) => [key, generationResult.accounts.target?.fields[key]] as const
        ),
        ...Object.entries(generationResult.accounts.target?.fields ?? {}).filter(
          ([key]) => !CREDENTIAL_FIELD_ORDER.includes(key)
        )
      ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    : [];

  return (
    <div className="workspace-stack">
      <Card>
        <SectionHeading
          eyebrow="Runtime"
          title="Execution Overview"
          description="Run provider checks and user generation with the active saved configuration."
        />

        <dl className="summary-grid">
          <div>
            <dt>Provider</dt>
            <dd>{configState.config.aiProvider ?? "Not selected"}</dd>
          </div>
          <div>
            <dt>Backend</dt>
            <dd>{configState.config.providerBackend ?? "Not selected"}</dd>
          </div>
          <div>
            <dt>Repo</dt>
            <dd>{configState.config.automationRepoPath ?? "Not selected"}</dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{configState.config.lastEnvironment ?? "Not selected"}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <SectionHeading
          eyebrow="Provider Check"
          title="Validate Provider Runtime"
          description="Sends a prompt through POST /api/provider/execute using the saved provider, backend, repo path, and environment."
        />

        <details className="advanced-panel">
          <summary>Provider prompt and runtime check</summary>

          <div className="advanced-controls">
            <Field>
              <Label>Provider Prompt</Label>
              <textarea
                className="ui-textarea"
                disabled={isExecuting}
                onChange={(event) => onExecutionPromptChange(event.target.value)}
                rows={6}
                value={executionPrompt}
              />
            </Field>

            {selectedEnvironment && (
              <p className="helper-text">
                Environment metadata: <InlineCode>{selectedEnvironment.category}</InlineCode>
                {selectedEnvironment.normalizedValue
                  ? `, normalized to ${selectedEnvironment.normalizedValue}`
                  : ""}
              </p>
            )}

            <div className="action-row">
              <Button disabled={isExecuting || executionPrompt.trim().length === 0} onClick={onExecutePrompt}>
                {isExecuting ? "Running Provider" : "Run Provider Check"}
              </Button>
            </div>

            {executionResult && (
              <div className="result-card">
                <div className="result-meta">
                  <StatusBadge tone="neutral">{executionResult.provider}</StatusBadge>
                  <StatusBadge tone="neutral">{executionResult.backend}</StatusBadge>
                  <StatusBadge tone="neutral">{executionResult.environment}</StatusBadge>
                </div>
                {executionResult.warnings.length > 0 && (
                  <ul className="choice-warnings">
                    {executionResult.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
                <pre>{executionResult.output}</pre>
              </div>
            )}
          </div>
        </details>
      </Card>

      <Card>
        <SectionHeading
          eyebrow="Generation"
          title="Generate User Credentials"
          description="Runs the selected Playwright test in a sandbox and returns generated credential fields."
        />

        <Field>
          <Label>User Generation Prompt</Label>
          <textarea
            className="ui-textarea"
            disabled={isGenerating}
            onChange={(event) => onGenerationPromptChange(event.target.value)}
            rows={3}
            value={generationPrompt}
          />
        </Field>

        <details
          className="advanced-panel"
          onToggle={(event) => onAdvancedOpenChange((event.target as HTMLDetailsElement).open)}
          open={isAdvancedOpen}
        >
          <summary>Advanced options</summary>
          <div className="advanced-controls">
            <label
              className="ui-toggle tooltip-toggle"
              title="Executes the test to create the user, but strips out all assertions (e.g., expect statements) to optimize execution speed. The actual test code (API/UI interactions) will still run."
            >
              <input
                checked={isFastMode}
                disabled={isGenerating}
                onChange={(event) => onFastModeChange(event.target.checked)}
                type="checkbox"
              />
              Fast Mode
            </label>
            <label className="ui-toggle">
              <input
                checked={enableRcpMock}
                disabled={isGenerating}
                onChange={(event) => onEnableRcpMockChange(event.target.checked)}
                type="checkbox"
              />
              Enable RCP mock before sandbox run (waits for workflow completion)
            </label>
            <label className="ui-toggle">
              <input
                checked={keepSandbox}
                disabled={isGenerating}
                onChange={(event) => onKeepSandboxChange(event.target.checked)}
                type="checkbox"
              />
              Keep sandbox directory after run
            </label>
            <label className="ui-toggle">
              <input
                checked={trustUnknown}
                disabled={isGenerating}
                onChange={(event) => onTrustUnknownChange(event.target.checked)}
                type="checkbox"
              />
              Trust unknown repo fingerprint
            </label>
            <label className="ui-toggle">
              <input
                checked={trustUncertainTeardown}
                disabled={isGenerating}
                onChange={(event) => onTrustUncertainTeardownChange(event.target.checked)}
                type="checkbox"
              />
              Trust uncertain teardown classification
            </label>
          </div>
        </details>

        <div className="action-row">
          <Button disabled={isGenerating || generationPrompt.trim().length === 0} onClick={onGenerateUser}>
            {isGenerating ? "Generating User" : "Generate User"}
          </Button>
        </div>

        {isGenerating && (
          <div aria-live="polite" className="loading-card" role="status">
            <div className="loading-header">
              <span aria-hidden className="loading-spinner" />
              <strong>Running test in sandbox</strong>
            </div>
            <p className="helper-text">{generationStatusMessage}</p>
            <div aria-hidden className="loading-progress-track">
              <div className="loading-progress-fill" />
            </div>
            <p className="loading-elapsed">
              Elapsed: <strong>{formatElapsedTime(generationElapsedSeconds)}</strong>
            </p>
          </div>
        )}

        {generationError && (
          <Banner tone="error">
            <div>{generationError.message}</div>
            {generationError.details && generationError.details.length > 0 && (
              <ul className="choice-warnings">
                {generationError.details.map((detail) => (
                  <li key={detail}>
                    <InlineCode>{detail}</InlineCode>
                  </li>
                ))}
              </ul>
            )}
            {generationError.logFile && (
              <p className="helper-text">
                Run log: <InlineCode>{generationError.logFile}</InlineCode>
              </p>
            )}
          </Banner>
        )}

        {generationResult && (
          <div className="result-card">
            <div className="result-meta">
              <StatusBadge tone="neutral">{generationResult.selectedTest.title}</StatusBadge>
              <StatusBadge tone="neutral">confidence {generationResult.confidence.toFixed(2)}</StatusBadge>
              <StatusBadge tone={generationResult.compatibility === "supported" ? "success" : "warning"}>
                {generationResult.compatibility}
              </StatusBadge>
              <StatusBadge tone={generationResult.runState.partial ? "warning" : "success"}>
                {generationResult.runState.partial ? "partial run-state" : "complete run-state"}
              </StatusBadge>
            </div>
            <p className="helper-text">Source: {generationResult.selectedTest.filePath}</p>
            {generationResult.accounts.target && (
              <p className="helper-text">
                Target account: {generationResult.accounts.target.id} ({generationResult.accounts.target.provisioningState},{" "}
                {generationResult.accounts.target.usable ? "usable" : "not usable"})
              </p>
            )}
            {generationResult.warnings.length > 0 && (
              <ul className="choice-warnings">
                {generationResult.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}

            {credentialEntries.length === 0 ? (
              <p className="helper-text">No credential fields were produced.</p>
            ) : (
              <dl className="credential-table">
                {credentialEntries.map(([key, value]) => (
                  <div className="credential-row" key={key}>
                    <dt>{CREDENTIAL_FIELD_LABELS[key] ?? key}</dt>
                    <dd>
                      <InlineCode>{value}</InlineCode>
                      <button
                        className="copy-button"
                        onClick={() => onCopyFieldValue(key, value)}
                        type="button"
                      >
                        {copiedField === key ? "Copied" : "Copy"}
                      </button>
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <div className="action-row">
              <Button onClick={onDownloadResult} tone="secondary">
                Download JSON
              </Button>
              <Button
                onClick={() => onCopyFieldValue("export-env", exportEnvLines.join("\n"))}
                tone="secondary"
              >
                {copiedField === "export-env" ? "Copied export env" : "Copy export env"}
              </Button>
            </div>

            {exportEnvLines.length > 0 && (
              <details className="export-preview">
                <summary>Export env preview</summary>
                <pre>{exportEnvLines.join("\n")}</pre>
              </details>
            )}

            <p className="helper-text">Sandbox: {generationResult.sandboxPath}</p>
            {generationResult.accounts.secondary.length > 0 && (
              <p className="helper-text">
                Secondary accounts captured: {generationResult.accounts.secondary.length}
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
};
