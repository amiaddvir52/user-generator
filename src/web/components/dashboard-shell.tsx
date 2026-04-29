import React from "react";

import type { ConfigResponse } from "../../shared/contracts.js";
import type { AppSection } from "../lib/types.js";
import { Button, StatusBadge } from "./primitives.js";

type ShellProps = {
  activeSection: AppSection;
  canAccessRuntime: boolean;
  configState: ConfigResponse;
  onSelectSection: (section: AppSection) => void;
  children: React.ReactNode;
};

const sectionCopy: Record<AppSection, { label: string; subtitle: string }> = {
  setup: {
    label: "Setup",
    subtitle: "Provider, repo, and environment configuration"
  },
  runtime: {
    label: "Runtime",
    subtitle: "Provider checks and user generation"
  },
  history: {
    label: "History",
    subtitle: "Recent successful generation runs"
  },
  settings: {
    label: "Settings",
    subtitle: "Edit and persist defaults"
  }
};

const buildRuntimeStateLabel = ({
  config,
  environments
}: Pick<ConfigResponse, "config" | "environments">) => {
  if (!config.aiProvider || !config.providerBackend) {
    return "Provider setup needed";
  }

  if (!config.automationRepoPath) {
    return "Automation repo needed";
  }

  if (
    !config.lastEnvironment ||
    !environments.some((environment) => environment.value === config.lastEnvironment)
  ) {
    return "Environment setup needed";
  }

  return "Ready";
};

export const DashboardShell = ({
  activeSection,
  canAccessRuntime,
  configState,
  onSelectSection,
  children
}: ShellProps) => {
  const runtimeStateLabel = buildRuntimeStateLabel(configState);
  const runtimeTone = runtimeStateLabel === "Ready" ? "success" : "warning";

  return (
    <main className="dashboard-root">
      <div className="dashboard-shell">
        <aside className="dashboard-sidebar">
          <div className="sidebar-brand">
            <p className="sidebar-eyebrow">User Generator</p>
            <h1>Admin Console</h1>
            <p>Professional workspace for provider onboarding and sandbox user runs.</p>
          </div>

          <nav aria-label="Primary" className="sidebar-nav">
            {(["setup", "runtime", "history", "settings"] as AppSection[]).map((section) => {
              const isRuntimeDisabled = section === "runtime" && !canAccessRuntime;
              const selected = activeSection === section;
              const copy = sectionCopy[section];

              return (
                <button
                  aria-current={selected ? "page" : undefined}
                  className={`sidebar-nav-item${selected ? " selected" : ""}`}
                  disabled={isRuntimeDisabled}
                  key={section}
                  onClick={() => onSelectSection(section)}
                  type="button"
                >
                  <span className="sidebar-nav-label">{copy.label}</span>
                  <span className="sidebar-nav-subtitle">{copy.subtitle}</span>
                </button>
              );
            })}
          </nav>

          <div className="sidebar-status">
            <div className="status-row">
              <span>Runtime State</span>
              <StatusBadge tone={runtimeTone}>{runtimeStateLabel}</StatusBadge>
            </div>
            <div className="status-row">
              <span>Provider</span>
              <span>{configState.config.aiProvider ?? "Not selected"}</span>
            </div>
            <div className="status-row">
              <span>Environment</span>
              <span>{configState.config.lastEnvironment ?? "Not selected"}</span>
            </div>
            <Button onClick={() => onSelectSection("settings")} size="sm" tone="secondary">
              Open Settings
            </Button>
          </div>
        </aside>

        <div className="dashboard-main">
          <header className="dashboard-topbar">
            <div>
              <p className="topbar-title">{sectionCopy[activeSection].label}</p>
              <p className="topbar-subtitle">{sectionCopy[activeSection].subtitle}</p>
            </div>
            <div className="topbar-meta">
              <span className="topbar-chip">Config: {configState.configFile}</span>
            </div>
          </header>

          <div className="dashboard-content">{children}</div>
        </div>
      </div>
    </main>
  );
};
