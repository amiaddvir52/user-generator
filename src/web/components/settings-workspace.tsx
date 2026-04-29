import React from "react";

import type { AIProvider } from "../../shared/config.js";
import type { ConfigResponse } from "../../shared/contracts.js";
import { formatProviderWarnings } from "../lib/helpers.js";
import { Button, Card, Field, Label, SectionHeading, StatusBadge } from "./primitives.js";

type SettingsWorkspaceProps = {
  configState: ConfigResponse;
  isSaving: boolean;
  onCancel: () => void;
  onSave: () => void;
  setSettingsProvider: (provider: AIProvider) => void;
  setSettingsRepoPath: (path: string) => void;
  settingsProvider: AIProvider;
  settingsRepoPath: string;
};

export const SettingsWorkspace = ({
  configState,
  isSaving,
  onCancel,
  onSave,
  setSettingsProvider,
  setSettingsRepoPath,
  settingsProvider,
  settingsRepoPath
}: SettingsWorkspaceProps) => {
  const settingsProviderOption = configState.providers.find((provider) => provider.id === settingsProvider);
  const providerAvailable =
    configState.providers.find((provider) => provider.id === settingsProvider)?.available ?? false;

  return (
    <div className="workspace-stack">
      <Card>
        <SectionHeading
          eyebrow="Configuration"
          title="Saved Settings"
          description="Update persisted defaults for provider and repository path."
        />

        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <Field>
            <Label>AI Provider</Label>
            <div className="pill-row">
              {configState.providers.map((provider) => (
                <button
                  className={`pill${settingsProvider === provider.id ? " selected" : ""}`}
                  disabled={!provider.available}
                  key={provider.id}
                  onClick={() => setSettingsProvider(provider.id)}
                  type="button"
                >
                  <span>{provider.label}</span>
                  {settingsProvider === provider.id && <StatusBadge tone="success">Selected</StatusBadge>}
                </button>
              ))}
            </div>

            {settingsProviderOption && formatProviderWarnings(settingsProviderOption).length > 0 && (
              <ul className="choice-warnings inline">
                {formatProviderWarnings(settingsProviderOption).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </Field>

          <Field>
            <Label>Automation Repo Path</Label>
            <input
              className="ui-input"
              disabled={isSaving}
              onChange={(event) => setSettingsRepoPath(event.target.value)}
              type="text"
              value={settingsRepoPath}
            />
          </Field>

          <div className="action-row">
            <Button
              disabled={
                isSaving || settingsRepoPath.trim().length === 0 || !providerAvailable
              }
              type="submit"
            >
              Save Settings
            </Button>
            <Button onClick={onCancel} tone="secondary" type="button">
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
};
