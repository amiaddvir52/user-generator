import React from "react";

import type { ConfigResponse } from "../../shared/contracts.js";
import { completionForStep, formatProviderWarnings, summarizeSources } from "../lib/helpers.js";
import { Banner, Button, Card, Field, Label, SectionHeading, StatusBadge } from "./primitives.js";

type SetupWorkspaceProps = {
  configState: ConfigResponse;
  environmentSelection: string;
  isSaving: boolean;
  onEnvironmentSelectionChange: (value: string) => void;
  onOpenSettings: () => void;
  onSaveEnvironment: () => void;
  onSaveRepo: () => void;
  onSelectProvider: (providerId: string) => void;
  repoPathInput: string;
  setRepoPathInput: (value: string) => void;
};

const statusToneForCompletion = (completed: boolean) => (completed ? "success" : "warning");

export const SetupWorkspace = ({
  configState,
  environmentSelection,
  isSaving,
  onEnvironmentSelectionChange,
  onOpenSettings,
  onSaveEnvironment,
  onSaveRepo,
  onSelectProvider,
  repoPathInput,
  setRepoPathInput
}: SetupWorkspaceProps) => {
  const completedProvider = completionForStep("provider", configState.config, configState.environments);
  const completedRepo = completionForStep("automationRepo", configState.config, configState.environments);
  const completedEnvironment = completionForStep("environment", configState.config, configState.environments);
  const availableProviderCount = configState.providers.filter((provider) => provider.available).length;

  return (
    <div className="workspace-stack">
      <Card>
        <SectionHeading
          eyebrow="Configuration"
          title="Setup Workspace"
          description="Complete provider, repository, and environment setup before running sandbox generation flows."
          action={
            <Button onClick={onOpenSettings} tone="secondary">
              Edit Saved Defaults
            </Button>
          }
        />

        <ol className="setup-checklist" aria-label="Onboarding progress">
          <li>
            <div>
              <strong>Provider & backend</strong>
              <p>Select a provider that is actually available on this machine.</p>
            </div>
            <StatusBadge tone={statusToneForCompletion(completedProvider)}>
              {completedProvider ? "Done" : "Pending"}
            </StatusBadge>
          </li>
          <li>
            <div>
              <strong>Automation repo</strong>
              <p>Persist an absolute local git repository path for runtime commands.</p>
            </div>
            <StatusBadge tone={statusToneForCompletion(completedRepo)}>
              {completedRepo ? "Done" : "Pending"}
            </StatusBadge>
          </li>
          <li>
            <div>
              <strong>Environment</strong>
              <p>Pick a discovered environment from the selected repository catalog.</p>
            </div>
            <StatusBadge tone={statusToneForCompletion(completedEnvironment)}>
              {completedEnvironment ? "Done" : "Pending"}
            </StatusBadge>
          </li>
        </ol>
      </Card>

      <Card>
        <SectionHeading
          eyebrow="Step 1"
          title="Provider Selection"
          description="Only providers with a runnable backend can be selected and saved."
        />

        <div className="choice-grid">
          {configState.providers.map((provider) => {
            const warnings = formatProviderWarnings(provider);
            const selected = configState.config.aiProvider === provider.id;

            return (
              <button
                className={`choice-card${selected ? " selected" : ""}${provider.available ? "" : " unavailable"}`}
                disabled={isSaving || !provider.available}
                key={provider.id}
                onClick={() => onSelectProvider(provider.id)}
                type="button"
              >
                <div className="choice-header">
                  <span className="choice-title">{provider.label}</span>
                  <StatusBadge tone={provider.available ? "success" : "danger"}>
                    {provider.available ? "Available" : "Unavailable"}
                  </StatusBadge>
                </div>
                <p className="choice-description">
                  {provider.defaultBackend
                    ? `Default backend: ${provider.defaultBackend}`
                    : "No supported backend detected."}
                </p>
                {warnings.length > 0 && (
                  <ul className="choice-warnings">
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </button>
            );
          })}
        </div>

        {availableProviderCount === 0 && (
          <p className="helper-text">
            No supported provider backends are currently available. Configure a provider toolchain and
            refresh.
          </p>
        )}
      </Card>

      <Card>
        <SectionHeading
          eyebrow="Step 2"
          title="Automation Repository"
          description="The path must exist locally and include a .git entry."
        />

        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveRepo();
          }}
        >
          <Field>
            <Label>Automation Repo Path</Label>
            <input
              className="ui-input"
              disabled={isSaving}
              onChange={(event) => setRepoPathInput(event.target.value)}
              placeholder="/Users/you/dev/automation/cloud-automation"
              type="text"
              value={repoPathInput}
            />
            <p className="helper-text">Absolute path only. Relative paths are rejected by the API.</p>
          </Field>
          <div className="action-row">
            <Button disabled={isSaving || repoPathInput.trim().length === 0} type="submit">
              Save Repo Location
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <SectionHeading
          eyebrow="Step 3"
          title="Environment Selection"
          description="Environments are discovered from your repository, including aliases and CI-only entries."
        />

        {configState.environments.length === 0 ? (
          <Banner tone="warning">
            <strong>No environments discovered.</strong>
            <p className="helper-text">Verify the repo path and environment source files, then reload setup.</p>
          </Banner>
        ) : (
          <>
            <div className="choice-grid compact">
              {configState.environments.map((environment) => (
                <button
                  className={`choice-card${environmentSelection === environment.value ? " selected" : ""}`}
                  key={environment.value}
                  onClick={() => onEnvironmentSelectionChange(environment.value)}
                  type="button"
                >
                  <div className="choice-header">
                    <span className="choice-title">{environment.value}</span>
                    <StatusBadge tone="neutral">{environment.category}</StatusBadge>
                  </div>
                  <p className="choice-description">
                    {environment.normalizedValue
                      ? `Resolves to ${environment.normalizedValue}`
                      : "No normalization applied."}
                  </p>
                  <p className="choice-support">{summarizeSources(environment)}</p>
                  {environment.warnings.length > 0 && (
                    <ul className="choice-warnings">
                      {environment.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </button>
              ))}
            </div>

            <div className="action-row">
              <Button disabled={isSaving || environmentSelection.length === 0} onClick={onSaveEnvironment}>
                Save Environment
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
};
