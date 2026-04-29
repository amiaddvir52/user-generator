import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoHandle } from "../src/tug/common/types.js";
import { TugError } from "../src/tug/common/errors.js";

const shellMocks = vi.hoisted(() => ({
  runShellCommand: vi.fn()
}));

vi.mock("../src/tug/common/shell.js", () => ({
  runShellCommand: shellMocks.runShellCommand
}));

const repo: RepoHandle = {
  absPath: "/tmp/repo",
  smRootPath: "/tmp/repo/e2e-automation/sm-ui-refresh",
  packageName: "@test/repo",
  packageVersion: "1.0.0",
  playwrightConfigPath: "/tmp/repo/e2e-automation/sm-ui-refresh/playwright.config.ts",
  tsconfigPath: "/tmp/repo/e2e-automation/sm-ui-refresh/tsconfig.json",
  lockfilePath: "/tmp/repo/pnpm-lock.yaml",
  packageManagerCommand: ["pnpm"],
  gitSha: "abc123",
  isDirty: false
};

const configPath = path.join("/tmp", "sandbox", "playwright.gen.config.ts");

const missingTemporalOutput = [
  "Error: Cannot find module '@temporalio/client'",
  "Require stack:",
  "- /tmp/repo/packages/api-clients/http-clients/temporal-client.ts",
  "- /tmp/repo/packages/api-clients/index.ts"
].join("\n");

beforeEach(() => {
  shellMocks.runShellCommand.mockReset();
});

describe("runPlaywrightList dependency restore", () => {
  it("runs pnpm install and retries once when Playwright discovery hits a missing package", async () => {
    shellMocks.runShellCommand
      .mockResolvedValueOnce({
        command: ["pnpm", "playwright"],
        cwd: repo.absPath,
        stdout: "",
        stderr: missingTemporalOutput,
        exitCode: 1
      })
      .mockResolvedValueOnce({
        command: ["pnpm", "install", "--frozen-lockfile"],
        cwd: repo.absPath,
        stdout: "installed",
        stderr: "",
        exitCode: 0
      })
      .mockResolvedValueOnce({
        command: ["pnpm", "playwright"],
        cwd: repo.absPath,
        stdout: "  [chromium] › Accounts › creates account\n",
        stderr: "",
        exitCode: 0
      });

    const { runPlaywrightList } = await import("../src/tug/validate/playwright-list.js");
    await expect(
      runPlaywrightList({
        repo,
        configPath,
        expectedTitle: "Accounts › creates account"
      })
    ).resolves.toEqual({
      rawOutput: "  [chromium] › Accounts › creates account\n",
      tests: ["Accounts › creates account"]
    });

    expect(shellMocks.runShellCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: ["pnpm", "install", "--frozen-lockfile"],
        cwd: repo.absPath
      })
    );
    expect(shellMocks.runShellCommand).toHaveBeenCalledTimes(3);
  });

  it("fails with an actionable missing dependency message when install does not fix it", async () => {
    shellMocks.runShellCommand
      .mockResolvedValueOnce({
        command: ["pnpm", "playwright"],
        cwd: repo.absPath,
        stdout: "",
        stderr: missingTemporalOutput,
        exitCode: 1
      })
      .mockResolvedValueOnce({
        command: ["pnpm", "install", "--frozen-lockfile"],
        cwd: repo.absPath,
        stdout: "already up to date",
        stderr: "",
        exitCode: 0
      })
      .mockResolvedValueOnce({
        command: ["pnpm", "playwright"],
        cwd: repo.absPath,
        stdout: "",
        stderr: missingTemporalOutput,
        exitCode: 1
      });

    const { runPlaywrightList } = await import("../src/tug/validate/playwright-list.js");

    let captured: TugError | undefined;
    try {
      await runPlaywrightList({ repo, configPath });
    } catch (error) {
      captured = error as TugError;
    }

    expect(captured).toBeInstanceOf(TugError);
    expect(captured?.reason).toBe("VALIDATION_FAILED");
    expect(captured?.message).toContain("@temporalio/client");
    expect(captured?.details).toEqual(
      expect.arrayContaining([
        "Missing module: @temporalio/client",
        expect.stringContaining("declare @temporalio/client in the package.json"),
        expect.stringContaining("temporal-client.ts")
      ])
    );
  });
});
