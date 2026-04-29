import React, { useEffect, useState } from "react";

import type { AIProvider } from "../shared/config.js";
import type {
  ConfigResponse,
  ProviderExecutionResponse,
  RunHistoryEntry,
  UserGenerationResponse
} from "../shared/contracts.js";
import { ConfirmationModal } from "./components/confirmation-modal.js";
import { DashboardShell } from "./components/dashboard-shell.js";
import { HistoryWorkspace } from "./components/history-workspace.js";
import { Button } from "./components/primitives.js";
import { RuntimeWorkspace } from "./components/runtime-workspace.js";
import { SettingsWorkspace } from "./components/settings-workspace.js";
import { SetupWorkspace } from "./components/setup-workspace.js";
import {
  UserGenerationApiError,
  fetchConfig,
  fetchRunHistory,
  postJson,
  postUserGeneration
} from "./lib/api.js";
import {
  DEFAULT_EXECUTION_PROMPT,
  DEFAULT_GENERATION_OVERRIDES,
  DEFAULT_USER_GENERATION_PROMPT
} from "./lib/constants.js";
import {
  chooseInitialEnvironment,
  chooseInitialProvider,
  chooseInitialSection,
  completionForStep,
  downloadJson,
  toExportEnvLines
} from "./lib/helpers.js";
import type {
  AppSection,
  GenerationErrorState,
  LegacyView,
  PendingConfirmation,
  UserGenerationRequest
} from "./lib/types.js";

export const App = () => {
  const [activeSection, setActiveSection] = useState<AppSection>("setup");
  const [configState, setConfigState] = useState<ConfigResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [repoPathInput, setRepoPathInput] = useState("");
  const [settingsProvider, setSettingsProvider] = useState<AIProvider>("codex");
  const [settingsRepoPath, setSettingsRepoPath] = useState("");
  const [environmentSelection, setEnvironmentSelection] = useState("");
  const [executionPrompt, setExecutionPrompt] = useState(DEFAULT_EXECUTION_PROMPT);
  const [executionResult, setExecutionResult] = useState<ProviderExecutionResponse | null>(null);
  const [generationPrompt, setGenerationPrompt] = useState(DEFAULT_USER_GENERATION_PROMPT);
  const [keepSandbox, setKeepSandbox] = useState(false);
  const [enableRcpMock, setEnableRcpMock] = useState(false);
  const [trustUnknown, setTrustUnknown] = useState(DEFAULT_GENERATION_OVERRIDES.trustUnknown);
  const [trustUncertainTeardown, setTrustUncertainTeardown] = useState(
    DEFAULT_GENERATION_OVERRIDES.trustUncertainTeardown
  );
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [generationElapsedSeconds, setGenerationElapsedSeconds] = useState(0);
  const [generationResult, setGenerationResult] = useState<UserGenerationResponse | null>(null);
  const [generationError, setGenerationError] = useState<GenerationErrorState | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [runHistoryEntries, setRunHistoryEntries] = useState<RunHistoryEntry[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const hydrateState = (nextState: ConfigResponse, preferredView?: LegacyView) => {
    setConfigState(nextState);
    setRepoPathInput(nextState.config.automationRepoPath ?? "");
    setSettingsProvider(chooseInitialProvider(nextState));
    setSettingsRepoPath(nextState.config.automationRepoPath ?? "");
    setEnvironmentSelection(chooseInitialEnvironment(nextState));
    setExecutionResult(null);
    setGenerationResult(null);
    setGenerationError(null);
    setPendingConfirmation(null);
    setActiveSection((current) => chooseInitialSection(nextState, preferredView, current));
  };

  useEffect(() => {
    const loadRunHistory = async () => {
      try {
        const history = await fetchRunHistory();
        setRunHistoryEntries(history.entries);
        setHistoryError(null);
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsLoadingHistory(false);
      }
    };

    const load = async () => {
      try {
        const nextState = await fetchConfig();
        hydrateState(nextState);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setIsLoading(false);
      }
    };

    void load();
    void loadRunHistory();
  }, []);

  const refreshRunHistory = async () => {
    try {
      const history = await fetchRunHistory();
      setRunHistoryEntries(history.entries);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!isGenerating || generationStartedAt === null) {
      return;
    }

    const tick = () => {
      const elapsedSeconds = Math.floor((Date.now() - generationStartedAt) / 1000);
      setGenerationElapsedSeconds(Math.max(0, elapsedSeconds));
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [isGenerating, generationStartedAt]);

  const persist = async (request: Promise<ConfigResponse>, nextView?: LegacyView) => {
    setIsSaving(true);
    setErrorMessage(null);

    try {
      const nextState = await request;
      hydrateState(nextState, nextView);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !configState) {
    return (
      <main className="loading-screen">
        <section className="loading-panel">
          <p className="section-eyebrow">User Generator</p>
          <h1>Preparing dashboard workspace...</h1>
        </section>
      </main>
    );
  }

  const selectedEnvironment = configState.environments.find(
    (environment) => environment.value === environmentSelection
  );

  const canAccessRuntime =
    completionForStep("provider", configState.config, configState.environments) &&
    completionForStep("automationRepo", configState.config, configState.environments) &&
    completionForStep("environment", configState.config, configState.environments);

  const executePrompt = async () => {
    setIsExecuting(true);
    setErrorMessage(null);

    try {
      const result = await postJson<ProviderExecutionResponse, { prompt: string; environment?: string }>(
        "/api/provider/execute",
        {
          prompt: executionPrompt,
          environment: environmentSelection || undefined
        }
      );
      setExecutionResult(result);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExecuting(false);
    }
  };

  const runGeneration = async (request: UserGenerationRequest) => {
    const requestWithDefaults: UserGenerationRequest = {
      ...DEFAULT_GENERATION_OVERRIDES,
      ...request
    };

    setIsGenerating(true);
    setGenerationStartedAt(Date.now());
    setGenerationElapsedSeconds(0);
    setGenerationError(null);
    setCopiedField(null);

    try {
      const result = await postUserGeneration(requestWithDefaults);
      setGenerationResult(result);
      setPendingConfirmation(null);
      await refreshRunHistory();
    } catch (error) {
      if (error instanceof UserGenerationApiError && error.status === 409) {
        setPendingConfirmation({ error: error.payload, baseRequest: requestWithDefaults });
        setGenerationError(null);
      } else if (error instanceof UserGenerationApiError) {
        setPendingConfirmation(null);
        setGenerationError({
          message: error.payload.message,
          details: error.payload.details,
          logFile: error.payload.logFile
        });
      } else {
        setPendingConfirmation(null);
        setGenerationError({
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      setIsGenerating(false);
      setGenerationStartedAt(null);
    }
  };

  const generateUser = async () => {
    setGenerationResult(null);
    setPendingConfirmation(null);

    await runGeneration({
      prompt: generationPrompt.trim(),
      environment: environmentSelection || undefined,
      enableRcpMock: enableRcpMock || undefined,
      keepSandbox: keepSandbox || undefined,
      trustUnknown,
      trustUncertainTeardown
    });
  };

  const rerunFromHistory = async (entry: RunHistoryEntry) => {
    setActiveSection("runtime");
    setGenerationPrompt(entry.request.prompt ?? DEFAULT_USER_GENERATION_PROMPT);
    setEnvironmentSelection(entry.request.environment);
    setEnableRcpMock(entry.request.enableRcpMock);
    setKeepSandbox(entry.request.keepSandbox);
    setTrustUnknown(entry.request.trustUnknown);
    setTrustUncertainTeardown(entry.request.trustUncertainTeardown);
    setIsAdvancedOpen(
      entry.request.enableRcpMock ||
        entry.request.keepSandbox ||
        !entry.request.trustUnknown ||
        !entry.request.trustUncertainTeardown
    );

    setGenerationResult(null);
    setPendingConfirmation(null);

    await runGeneration({
      prompt: entry.request.prompt,
      spec: entry.request.spec,
      test: entry.request.test,
      environment: entry.request.environment,
      executionMode: entry.request.executionMode,
      allowAutoFallback: entry.request.allowAutoFallback,
      enableRcpMock: entry.request.enableRcpMock,
      trustUnknown: entry.request.trustUnknown,
      trustUncertainTeardown: entry.request.trustUncertainTeardown,
      keepSandbox: entry.request.keepSandbox,
      reindex: entry.request.reindex
    });
  };

  const rerunLatestHistoryEntry = async () => {
    const latestEntry = runHistoryEntries[0];
    if (!latestEntry) {
      return;
    }

    await rerunFromHistory(latestEntry);
  };

  const confirmAmbiguousCandidate = async (choice: string) => {
    if (!pendingConfirmation) {
      return;
    }

    setPendingConfirmation(null);
    const [titleRaw, filePathRaw] = choice.split(" (");
    const title = titleRaw.trim();
    const filePath = filePathRaw ? filePathRaw.replace(/\)$/, "").trim() : "";
    if (!title || !filePath) {
      setGenerationError({ message: "Unable to parse candidate choice." });
      return;
    }

    await runGeneration({
      ...pendingConfirmation.baseRequest,
      prompt: undefined,
      spec: filePath,
      test: title
    });
  };

  const confirmWithOverrides = async (overrides: Partial<UserGenerationRequest>) => {
    if (!pendingConfirmation) {
      return;
    }

    setPendingConfirmation(null);
    await runGeneration({
      ...pendingConfirmation.baseRequest,
      ...overrides
    });
  };

  const copyFieldValue = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      window.setTimeout(() => {
        setCopiedField((current) => (current === field ? null : current));
      }, 1500);
    } catch {
      setGenerationError({ message: "Unable to copy to clipboard." });
    }
  };

  const exportEnvLines = generationResult?.accounts.target?.usable
    ? toExportEnvLines(generationResult.accounts.target.fields)
    : [];

  const renderWorkspace = () => {
    if (activeSection === "setup") {
      return (
        <SetupWorkspace
          configState={configState}
          environmentSelection={environmentSelection}
          isSaving={isSaving}
          onEnvironmentSelectionChange={setEnvironmentSelection}
          onOpenSettings={() => setActiveSection("settings")}
          onSaveEnvironment={() =>
            persist(
              postJson<ConfigResponse, { environment: string }>("/api/config/environment", {
                environment: environmentSelection
              }),
              "ready"
            )
          }
          onSaveRepo={() =>
            void persist(
              postJson<ConfigResponse, { automationRepoPath: string }>("/api/config/automation-repo", {
                automationRepoPath: repoPathInput
              })
            )
          }
          onSelectProvider={(providerId) =>
            void persist(
              postJson<ConfigResponse, { aiProvider: string }>("/api/config/provider", {
                aiProvider: providerId
              })
            )
          }
          repoPathInput={repoPathInput}
          setRepoPathInput={setRepoPathInput}
        />
      );
    }

    if (activeSection === "settings") {
      return (
        <SettingsWorkspace
          configState={configState}
          isSaving={isSaving}
          onCancel={() => setActiveSection(canAccessRuntime ? "runtime" : "setup")}
          onSave={() =>
            void persist(
              postJson<ConfigResponse, { aiProvider: string; automationRepoPath: string }>(
                "/api/config/settings",
                {
                  aiProvider: settingsProvider,
                  automationRepoPath: settingsRepoPath
                }
              ),
              configState.config.lastEnvironment ? "ready" : "environment"
            )
          }
          setSettingsProvider={setSettingsProvider}
          setSettingsRepoPath={setSettingsRepoPath}
          settingsProvider={settingsProvider}
          settingsRepoPath={settingsRepoPath}
        />
      );
    }

    if (activeSection === "history") {
      return (
        <HistoryWorkspace
          historyEntries={runHistoryEntries}
          historyError={historyError}
          isGenerating={isGenerating}
          isLoadingHistory={isLoadingHistory}
          onRerunEntry={(entry) => void rerunFromHistory(entry)}
          onRerunLatest={() => void rerunLatestHistoryEntry()}
        />
      );
    }

    return (
      <RuntimeWorkspace
        configState={configState}
        copiedField={copiedField}
        enableRcpMock={enableRcpMock}
        executionPrompt={executionPrompt}
        executionResult={executionResult}
        exportEnvLines={exportEnvLines}
        generationElapsedSeconds={generationElapsedSeconds}
        generationError={generationError}
        generationPrompt={generationPrompt}
        generationResult={generationResult}
        isAdvancedOpen={isAdvancedOpen}
        isExecuting={isExecuting}
        isGenerating={isGenerating}
        keepSandbox={keepSandbox}
        onAdvancedOpenChange={setIsAdvancedOpen}
        onCopyFieldValue={(field, value) => void copyFieldValue(field, value)}
        onDownloadResult={() =>
          generationResult && downloadJson(generationResult, `user-generator-${Date.now()}.json`)
        }
        onEnableRcpMockChange={setEnableRcpMock}
        onExecutePrompt={() => void executePrompt()}
        onExecutionPromptChange={setExecutionPrompt}
        onGenerateUser={() => void generateUser()}
        onGenerationPromptChange={setGenerationPrompt}
        onKeepSandboxChange={setKeepSandbox}
        onTrustUncertainTeardownChange={setTrustUncertainTeardown}
        onTrustUnknownChange={setTrustUnknown}
        selectedEnvironment={selectedEnvironment}
        trustUncertainTeardown={trustUncertainTeardown}
        trustUnknown={trustUnknown}
      />
    );
  };

  return (
    <>
      <DashboardShell
        activeSection={activeSection}
        canAccessRuntime={canAccessRuntime}
        configState={configState}
        onSelectSection={(section) => {
          if (section === "runtime" && !canAccessRuntime) {
            setActiveSection("setup");
            return;
          }

          setActiveSection(section);
        }}
      >
        {configState.recoveredFromCorruption && (
          <section className="ui-banner warning">
            A corrupted config file was backed up to <code>config.json.bak</code>, and onboarding restarted
            with a fresh configuration.
          </section>
        )}

        {configState.warnings.length > 0 && (
          <section className="ui-banner warning">
            <strong>Configuration warnings</strong>
            <ul className="choice-warnings inline">
              {configState.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        )}

        {errorMessage && <section className="ui-banner error">{errorMessage}</section>}

        {!canAccessRuntime && activeSection === "runtime" && (
          <section className="ui-banner warning">
            Complete setup before opening Runtime. Provider, repo path, and environment are all required.
            <div className="banner-action-row">
              <Button onClick={() => setActiveSection("setup")} size="sm" tone="secondary">
                Back to Setup
              </Button>
            </div>
          </section>
        )}

        {renderWorkspace()}
      </DashboardShell>

      <ConfirmationModal
        isGenerating={isGenerating}
        onClose={() => setPendingConfirmation(null)}
        onConfirmAmbiguousCandidate={(choice) => void confirmAmbiguousCandidate(choice)}
        onConfirmWithOverrides={(overrides) => void confirmWithOverrides(overrides)}
        pendingConfirmation={pendingConfirmation}
      />
    </>
  );
};
