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
  parseCredentialMarker: vi.fn(),
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
  parseCredentialMarker: workflowMocks.parseCredentialMarker
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
  workflowMocks.parseCredentialMarker.mockReturnValue({
    email: "a@b.com",
    password: "secret"
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
    expect(workflowMocks.runSandboxedTest).toHaveBeenCalledOnce();
  });

  it("falls back from fast mode to full mode when credentials are incomplete", async () => {
    workflowMocks.parseCredentialMarker
      .mockReturnValueOnce({
        accountId: "123"
      })
      .mockReturnValueOnce({
        email: "a@b.com",
        password: "secret"
      });

    workflowMocks.transformIntoSandbox
      .mockResolvedValueOnce({
        transform: {
          confidence: 0.91,
          removedCalls: []
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
      expect.objectContaining({ executionMode: "full" })
    );
    expect(result.executionMode).toBe("full");
    expect(result.fallbackTriggered).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Fast execution mode fallback triggered: reran in full mode for complete credentials."
      ])
    );
  });

  it("fails fast when auto-fallback is disabled", async () => {
    workflowMocks.parseCredentialMarker.mockReturnValueOnce({
      accountId: "123"
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
