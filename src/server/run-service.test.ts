import { beforeEach, describe, expect, it, vi } from "vitest";
import { TugError } from "../tug/common/errors.js";

const workflowMocks = vi.hoisted(() => ({
  loadRunContext: vi.fn(),
  buildExecutionEnv: vi.fn(),
  ensureRequiredEnvironment: vi.fn(),
  runPreflightGates: vi.fn(),
  getOrBuildIndex: vi.fn(),
  findEntryBySpecAndTitle: vi.fn(),
  transformIntoSandbox: vi.fn(),
  runSandboxedTest: vi.fn(),
  parseCredentialExecution: vi.fn(),
  cleanupSandbox: vi.fn(),
  enableRcpMockAndWait: vi.fn()
}));

vi.mock("../tug/common/context.js", () => ({
  loadRunContext: workflowMocks.loadRunContext
}));

vi.mock("../tug/common/runtime-env.js", () => ({
  buildExecutionEnv: workflowMocks.buildExecutionEnv
}));

vi.mock("../tug/validate/env-check.js", () => ({
  ensureRequiredEnvironment: workflowMocks.ensureRequiredEnvironment
}));

vi.mock("../tug/validate/gates.js", () => ({
  runPreflightGates: workflowMocks.runPreflightGates
}));

vi.mock("../tug/cli/workflow.js", () => ({
  getOrBuildIndex: workflowMocks.getOrBuildIndex,
  findEntryBySpecAndTitle: workflowMocks.findEntryBySpecAndTitle,
  transformIntoSandbox: workflowMocks.transformIntoSandbox
}));

vi.mock("../tug/execute/runner.js", () => ({
  runSandboxedTest: workflowMocks.runSandboxedTest
}));

vi.mock("../tug/execute/output-parser.js", () => ({
  parseCredentialExecution: workflowMocks.parseCredentialExecution
}));

vi.mock("../tug/sandbox/builder.js", () => ({
  cleanupSandbox: workflowMocks.cleanupSandbox
}));

vi.mock("./rcp-mock.js", () => ({
  enableRcpMockAndWait: workflowMocks.enableRcpMockAndWait
}));

import { executeUserGeneration } from "./run-service.js";

beforeEach(() => {
  vi.clearAllMocks();

  workflowMocks.loadRunContext.mockResolvedValue({
    repoPath: "/repo",
    environment: "qa.qa"
  });
  workflowMocks.buildExecutionEnv.mockReturnValue({});
  workflowMocks.ensureRequiredEnvironment.mockReturnValue(undefined);
  workflowMocks.runPreflightGates.mockResolvedValue({
    repo: {
      absPath: "/repo",
      packageName: "mock-package"
    },
    fingerprint: {
      fingerprint: "fingerprint-123"
    },
    compatibility: {
      status: "supported"
    },
    playwrightVersion: "1.0.0",
    warnings: ["preflight warning"]
  });
  workflowMocks.getOrBuildIndex.mockResolvedValue({
    index: {
      entries: []
    }
  });
  workflowMocks.findEntryBySpecAndTitle.mockReturnValue({
    filePath: "/repo/spec.ts",
    testTitle: "creates user",
    describeTitles: [],
    tags: []
  });
  workflowMocks.transformIntoSandbox.mockResolvedValue({
    transform: {
      confidence: 0.91,
      removedCalls: []
    },
    sandbox: {
      path: "/tmp/sandbox",
      playwrightConfigPath: "/tmp/playwright.config.ts",
      stdoutLogPath: "/tmp/stdout.log",
      stderrLogPath: "/tmp/stderr.log"
    }
  });
  workflowMocks.runSandboxedTest.mockResolvedValue({
    command: ["pnpm", "playwright"],
    markerLines: ["CREDENTIAL_MARKER"],
    stdout: "",
    stderr: ""
  });
  workflowMocks.parseCredentialExecution.mockReturnValue({
    events: [],
    runState: {
      completedFullFlow: true,
      partial: false
    },
    accounts: {
      target: {
        id: "a@b.com",
        fields: {
          email: "a@b.com",
          password: "secret"
        },
        sourcePhases: ["final"],
        provisioningState: "complete",
        usable: true
      },
      secondary: []
    },
    warning: undefined
  });
  workflowMocks.cleanupSandbox.mockResolvedValue(undefined);
  workflowMocks.enableRcpMockAndWait.mockResolvedValue({
    runId: 42,
    runUrl: "https://github.com/redislabsdev/cloud-automation/actions/runs/42"
  });
});

describe("executeUserGeneration with optional RCP mock gate", () => {
  it("defaults to fast execution mode with auto-fallback enabled", async () => {
    await executeUserGeneration({
      spec: "/repo/spec.ts",
      test: "creates user",
      environment: "qa.qa"
    });

    expect(workflowMocks.transformIntoSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "fast"
      })
    );
    expect(workflowMocks.runPreflightGates).toHaveBeenCalledWith(
      expect.objectContaining({
        dryList: false
      })
    );
    expect(workflowMocks.runSandboxedTest).toHaveBeenCalledOnce();
  });

  it("falls back from fast mode to full mode when credentials are incomplete", async () => {
    workflowMocks.parseCredentialExecution
      .mockReturnValueOnce({
        events: [],
        runState: {
          completedFullFlow: false,
          partial: true
        },
        accounts: {
          target: {
            id: "123",
            fields: {
              accountId: "123"
            },
            sourcePhases: ["entry"],
            provisioningState: "partial",
            usable: false
          },
          secondary: []
        },
        warning: "Warning: Test exited at line 42. Credential marker captured but provisioned state is partial/incomplete."
      })
      .mockReturnValueOnce({
        events: [],
        runState: {
          completedFullFlow: true,
          partial: false
        },
        accounts: {
          target: {
            id: "a@b.com",
            fields: {
              email: "a@b.com",
              password: "secret"
            },
            sourcePhases: ["final"],
            provisioningState: "complete",
            usable: true
          },
          secondary: []
        },
        warning: undefined
      });

    workflowMocks.transformIntoSandbox
      .mockResolvedValueOnce({
        transform: {
          confidence: 0.91,
          removedCalls: []
        },
        validationProof: {
          fingerprint: "fingerprint-123",
          sourceFile: "/repo/spec.ts",
          sourceTextHash: "source-hash",
          testTitle: "creates user",
          expectedTitle: "creates user",
          environment: {
            environment: null,
            cloudProvider: null,
            region: null
          },
          coversExecutionModes: ["fast", "full"]
        },
        sandbox: {
          path: "/tmp/sandbox-fast",
          playwrightConfigPath: "/tmp/playwright.fast.config.ts",
          stdoutLogPath: "/tmp/stdout.fast.log",
          stderrLogPath: "/tmp/stderr.fast.log"
        }
      })
      .mockResolvedValueOnce({
        transform: {
          confidence: 0.92,
          removedCalls: []
        },
        sandbox: {
          path: "/tmp/sandbox-full",
          playwrightConfigPath: "/tmp/playwright.full.config.ts",
          stdoutLogPath: "/tmp/stdout.full.log",
          stderrLogPath: "/tmp/stderr.full.log"
        }
      });

    const result = await executeUserGeneration({
      spec: "/repo/spec.ts",
      test: "creates user",
      environment: "qa.qa"
    });

    expect(workflowMocks.runSandboxedTest).toHaveBeenCalledTimes(2);
    expect(workflowMocks.transformIntoSandbox).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ executionMode: "fast" })
    );
    expect(workflowMocks.transformIntoSandbox).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        executionMode: "full",
        validationProof: expect.objectContaining({
          coversExecutionModes: ["fast", "full"]
        })
      })
    );
    expect(result.executionMode).toBe("full");
    expect(result.fallbackTriggered).toBe(true);
    expect(result.fastPathTriggered).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Fast execution mode fallback triggered: reran in full mode for complete credentials."
      ])
    );
  });

  it("does not rerun full mode when fast mode completed the full flow with unusable credentials", async () => {
    workflowMocks.parseCredentialExecution.mockReturnValueOnce({
      events: [],
      runState: {
        completedFullFlow: true,
        partial: false
      },
      accounts: {
        target: {
          id: "123",
          fields: {
            accountId: "123"
          },
          sourcePhases: ["final"],
          provisioningState: "complete",
          usable: false
        },
        secondary: []
      },
      warning: undefined
    });

    const result = await executeUserGeneration({
      spec: "/repo/spec.ts",
      test: "creates user",
      environment: "qa.qa"
    });

    expect(workflowMocks.runSandboxedTest).toHaveBeenCalledOnce();
    expect(workflowMocks.transformIntoSandbox).toHaveBeenCalledOnce();
    expect(result.executionMode).toBe("fast");
    expect(result.fallbackTriggered).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Target account is not fully provisioned or is missing primary credentials."
      ])
    );
  });

  it("keeps fast mode when fast-early-return yields usable credentials", async () => {
    workflowMocks.parseCredentialExecution.mockReturnValueOnce({
      events: [],
      runState: {
        completedFullFlow: false,
        partial: true,
        exitPhase: "fast-early-return",
        exitLine: 41
      },
      accounts: {
        target: {
          id: "a@b.com",
          fields: {
            email: "a@b.com",
            password: "secret",
            accountId: "123"
          },
          sourcePhases: ["entry", "fast-early-return"],
          provisioningState: "partial",
          usable: true
        },
        secondary: []
      },
      warning:
        "Warning: Test exited at line 41. Credential marker captured but provisioned state is partial/incomplete."
    });

    const result = await executeUserGeneration({
      spec: "/repo/spec.ts",
      test: "creates user",
      environment: "qa.qa"
    });

    expect(workflowMocks.runSandboxedTest).toHaveBeenCalledOnce();
    expect(workflowMocks.transformIntoSandbox).toHaveBeenCalledOnce();
    expect(result.executionMode).toBe("fast");
    expect(result.fallbackTriggered).toBe(false);
    expect(result.fastPathTriggered).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Warning: Test exited at line 41. Credential marker captured but provisioned state is partial/incomplete."
      ])
    );
    expect(result.warnings).not.toContain(
      "Target account is not fully provisioned or is missing primary credentials."
    );
    expect(result.timing).toEqual(
      expect.objectContaining({
        selectionMs: expect.any(Number),
        transformMs: expect.any(Number),
        executeMs: expect.any(Number),
        totalMs: expect.any(Number)
      })
    );
  });

  it("fails fast when auto-fallback is disabled", async () => {
    workflowMocks.parseCredentialExecution.mockReturnValueOnce({
      events: [],
      runState: {
        completedFullFlow: false,
        partial: true
      },
      accounts: {
        target: {
          id: "123",
          fields: {
            accountId: "123"
          },
          sourcePhases: ["entry"],
          provisioningState: "partial",
          usable: false
        },
        secondary: []
      },
      warning: "Warning: Test exited at line 42. Credential marker captured but provisioned state is partial/incomplete."
    });

    let captured: unknown;
    try {
      await executeUserGeneration({
        spec: "/repo/spec.ts",
        test: "creates user",
        environment: "qa.qa",
        allowAutoFallback: false
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TugError);
    expect((captured as TugError).reason).toBe("CREDENTIAL_MARKER_MISSING");
    expect(workflowMocks.runSandboxedTest).toHaveBeenCalledOnce();
    expect(workflowMocks.transformIntoSandbox).toHaveBeenCalledOnce();
  });

  it("waits for RCP mock workflow before running sandboxed test when enabled", async () => {
    const result = await executeUserGeneration({
      spec: "/repo/spec.ts",
      test: "creates user",
      environment: "qa.qa",
      enableRcpMock: true
    });

    expect(workflowMocks.enableRcpMockAndWait).toHaveBeenCalledOnce();
    expect(workflowMocks.runSandboxedTest).toHaveBeenCalledOnce();
    expect(
      workflowMocks.enableRcpMockAndWait.mock.invocationCallOrder[0]
    ).toBeLessThan(workflowMocks.runSandboxedTest.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "preflight warning",
        "RCP mock workflow run: https://github.com/redislabsdev/cloud-automation/actions/runs/42"
      ])
    );
  });

  it("surfaces partial-state warning when marker snapshots never reach final phase", async () => {
    workflowMocks.parseCredentialExecution.mockReturnValueOnce({
      events: [],
      runState: {
        completedFullFlow: false,
        partial: true,
        exitPhase: "fast-early-return",
        exitLine: 73
      },
      accounts: {
        target: {
          id: "a@b.com",
          fields: {
            email: "a@b.com",
            password: "secret"
          },
          sourcePhases: ["entry", "fast-early-return"],
          provisioningState: "partial",
          usable: false
        },
        secondary: []
      },
      warning:
        "Warning: Test exited at line 73. Credential marker captured but provisioned state is partial/incomplete."
    });

    const result = await executeUserGeneration({
      spec: "/repo/spec.ts",
      test: "creates user",
      environment: "qa.qa",
      executionMode: "full"
    });

    expect(result.runState.partial).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Warning: Test exited at line 73. Credential marker captured but provisioned state is partial/incomplete.",
        "Target account is not fully provisioned or is missing primary credentials."
      ])
    );
  });

  it("skips the RCP mock workflow when the flag is disabled", async () => {
    await executeUserGeneration({
      spec: "/repo/spec.ts",
      test: "creates user",
      environment: "qa.qa"
    });

    expect(workflowMocks.enableRcpMockAndWait).not.toHaveBeenCalled();
    expect(workflowMocks.runSandboxedTest).toHaveBeenCalledOnce();
  });
});
