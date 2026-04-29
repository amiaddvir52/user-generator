import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompatibilityResult,
  IndexData,
  RepoHandle,
  SandboxHandle,
  SpecIndexEntry
} from "../src/tug/common/types.js";

const tempRoots: string[] = [];

const workflowMocks = vi.hoisted(() => ({
  buildSandbox: vi.fn<() => Promise<SandboxHandle>>(),
  cleanupSandbox: vi.fn<() => Promise<void>>(),
  runTypecheck: vi.fn<() => Promise<void>>(),
  runPlaywrightList: vi.fn<() => Promise<{ rawOutput: string; tests: string[] }>>()
}));

const shellMocks = vi.hoisted(() => ({
  runShellCommand: vi.fn<() => Promise<{
    command: string[];
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number;
  }>>()
}));

vi.mock("../src/tug/sandbox/builder.js", () => ({
  buildSandbox: workflowMocks.buildSandbox,
  cleanupSandbox: workflowMocks.cleanupSandbox
}));

vi.mock("../src/tug/validate/typecheck.js", () => ({
  runTypecheck: workflowMocks.runTypecheck
}));

vi.mock("../src/tug/validate/playwright-list.js", () => ({
  runPlaywrightList: workflowMocks.runPlaywrightList
}));

vi.mock("../src/tug/common/shell.js", () => ({
  runShellCommand: shellMocks.runShellCommand,
  quoteForShellValue: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
}));

const createTempDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tug-workflow-"));
  tempRoots.push(directory);
  return directory;
};

const writeFile = async (root: string, relativePath: string, contents: string) => {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
  return absolutePath;
};

afterEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("transformIntoSandbox", () => {
  it("cleans up the sandbox when post-transform validation fails", async () => {
    const workspace = await createTempDir();
    const specPath = await writeFile(
      workspace,
      "account.spec.ts",
      [
        "declare const test: any;",
        "declare const expect: any;",
        "",
        "test.describe('Accounts', () => {",
        "  test('creates account', async () => {",
        "    expect(1).toBe(1);",
        "  });",
        "});"
      ].join("\n")
    );

    const sandbox: SandboxHandle = {
      path: path.join(workspace, "sandbox"),
      specPath: path.join(workspace, "sandbox", "gen.spec.ts"),
      playwrightConfigPath: path.join(workspace, "sandbox", "playwright.gen.config.ts"),
      tsconfigPath: path.join(workspace, "sandbox", "tsconfig.gen.json"),
      diffPath: path.join(workspace, "sandbox", "diff.patch"),
      runPlanPath: path.join(workspace, "sandbox", "run-plan.json"),
      stdoutLogPath: path.join(workspace, "sandbox", "stdout.log"),
      stderrLogPath: path.join(workspace, "sandbox", "stderr.log")
    };

    workflowMocks.buildSandbox.mockResolvedValue(sandbox);
    workflowMocks.cleanupSandbox.mockResolvedValue(undefined);
    workflowMocks.runTypecheck.mockRejectedValue(new Error("typecheck failed"));

    const { transformIntoSandbox } = await import("../src/tug/cli/workflow.js");

    const entry: SpecIndexEntry = {
      filePath: specPath,
      testTitle: "creates account",
      describeTitles: ["Accounts"],
      tags: [],
      helperImports: [],
      teardownCalls: [],
      scoreHints: {}
    };

    const index: IndexData = {
      fingerprint: "fp_test123",
      generatedAt: new Date().toISOString(),
      entries: [entry],
      teardown: {
        confirmed: [],
        suspected: [],
        scores: [],
        observedHookCalls: []
      }
    };

    const repo: RepoHandle = {
      absPath: workspace,
      smRootPath: workspace,
      packageName: "@test/repo",
      packageVersion: "1.0.0",
      playwrightConfigPath: path.join(workspace, "playwright.config.ts"),
      tsconfigPath: path.join(workspace, "tsconfig.json"),
      gitSha: "abc123",
      isDirty: false
    };

    const compatibility: CompatibilityResult = {
      status: "supported",
      fingerprint: "fp_test123",
      knownTeardownHints: []
    };

    await expect(
      transformIntoSandbox({
        entry,
        repo,
        fingerprint: "fp_test123",
        compatibility,
        index,
        interactiveConfirm: false
      })
    ).rejects.toThrow("typecheck failed");

    expect(workflowMocks.buildSandbox).toHaveBeenCalledOnce();
    expect(workflowMocks.cleanupSandbox).toHaveBeenCalledWith(sandbox);
    expect(workflowMocks.runPlaywrightList).not.toHaveBeenCalled();
  });
});

describe("runTypecheck", () => {
  const repo: RepoHandle = {
    absPath: "/tmp/repo",
    smRootPath: "/tmp/repo/e2e-automation/sm-ui-refresh",
    packageName: "@test/repo",
    packageVersion: "1.0.0",
    playwrightConfigPath: "/tmp/repo/playwright.config.ts",
    tsconfigPath: "/tmp/repo/tsconfig.json",
    gitSha: "abc123",
    isDirty: false
  };

  const importRealTypecheck = async () => {
    const actual = await vi.importActual<typeof import("../src/tug/validate/typecheck.js")>(
      "../src/tug/validate/typecheck.js"
    );
    return actual.runTypecheck;
  };

  it("succeeds when only repo-source files have errors", async () => {
    shellMocks.runShellCommand.mockResolvedValueOnce({
      command: ["pnpm", "exec", "tsc"],
      cwd: repo.smRootPath,
      stdout: [
        "playwright-clients/api-clients/database-api-client.ts(93,60): error TS2551: Property 'getBdbAvailableRedisVersionsForUpgrade' does not exist.",
        "playwright-helpers/gmail.helpers.ts(77,45): error TS2367: This comparison appears to be unintentional."
      ].join("\n"),
      stderr: "",
      exitCode: 1
    });

    const runTypecheck = await importRealTypecheck();
    await expect(runTypecheck({ repo, tsconfigPath: "/tmp/sandbox/tsconfig.gen.json" })).resolves.toBeUndefined();
  });

  it("fails with sandbox-spec error details when gen.spec.ts is the offender", async () => {
    shellMocks.runShellCommand.mockResolvedValueOnce({
      command: ["pnpm", "exec", "tsc"],
      cwd: repo.smRootPath,
      stdout: [
        "../../../../../.cache/test-user-generator/runs/abc/gen.spec.ts(1,30): error TS2307: Cannot find module '@playwright/test'.",
        "playwright-clients/api-clients/database-api-client.ts(93,60): error TS2551: Property 'getBdbAvailableRedisVersionsForUpgrade' does not exist."
      ].join("\n"),
      stderr: "",
      exitCode: 1
    });

    const runTypecheck = await importRealTypecheck();
    let captured: unknown;
    try {
      await runTypecheck({ repo, tsconfigPath: "/tmp/sandbox/tsconfig.gen.json" });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeDefined();
    const tugError = captured as { reason: string; details: string[] };
    expect(tugError.reason).toBe("VALIDATION_FAILED");
    expect(tugError.details).toHaveLength(1);
    expect(tugError.details[0]).toContain("gen.spec.ts");
    expect(tugError.details[0]).toContain("Cannot find module '@playwright/test'");
  });
});
