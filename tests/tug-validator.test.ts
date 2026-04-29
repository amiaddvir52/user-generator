import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shellMocks = vi.hoisted(() => ({
  runShellCommand: vi.fn()
}));

vi.mock("../src/tug/common/shell.js", () => ({
  runShellCommand: shellMocks.runShellCommand
}));

const tempRoots: string[] = [];
const previousPnpmCommand = process.env.TUG_PNPM_COMMAND;

const createTempDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tug-validator-"));
  tempRoots.push(directory);
  return directory;
};

const writeFile = async (root: string, relativePath: string, contents: string) => {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
  return absolutePath;
};

const createFixtureRepo = async () => {
  const repoDir = await createTempDir();
  await fs.mkdir(path.join(repoDir, ".git"));

  await writeFile(
    repoDir,
    "e2e-automation/sm-ui-refresh/package.json",
    JSON.stringify({ name: "@rediscloudauto/ui-refresh-automation-infra", version: "1.2.3" })
  );
  await writeFile(repoDir, "e2e-automation/sm-ui-refresh/tsconfig.json", "{\"compilerOptions\":{}}\n");
  await writeFile(repoDir, "e2e-automation/sm-ui-refresh/playwright.config.ts", "export default {}\n");
  await writeFile(
    repoDir,
    "e2e-automation/sm-ui-refresh/playwright-helpers/sm/sm.account.helpers.ts",
    "export const createAccount = async () => {};\n"
  );
  await writeFile(repoDir, "pnpm-lock.yaml", "packages:\n  /@playwright/test@1.55.0:\n");

  return repoDir;
};

beforeEach(() => {
  process.env.TUG_PNPM_COMMAND = "pnpm";
  shellMocks.runShellCommand.mockReset();
});

afterEach(async () => {
  if (previousPnpmCommand === undefined) {
    delete process.env.TUG_PNPM_COMMAND;
  } else {
    process.env.TUG_PNPM_COMMAND = previousPnpmCommand;
  }

  await Promise.all(tempRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("ensurePlaywrightInstalled", () => {
  it("restores automation repo dependencies from pnpm-lock when Playwright is missing", async () => {
    const repoDir = await createFixtureRepo();
    const { ensurePlaywrightInstalled, validateRepositoryStructure } = await import("../src/tug/repo/validator.js");

    shellMocks.runShellCommand.mockImplementation(async ({ command, cwd }) => {
      await writeFile(
        repoDir,
        "e2e-automation/sm-ui-refresh/node_modules/@playwright/test/package.json",
        JSON.stringify({ name: "@playwright/test", version: "1.55.0" })
      );

      return {
        command,
        cwd,
        stdout: "installed",
        stderr: "",
        exitCode: 0
      };
    });

    const repo = await validateRepositoryStructure(repoDir);
    await expect(ensurePlaywrightInstalled(repo)).resolves.toBe("1.55.0");

    expect(shellMocks.runShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["pnpm", "install", "--frozen-lockfile"],
        cwd: repoDir
      })
    );
  });

  it("accepts Playwright resolved from a workspace parent node_modules", async () => {
    const repoDir = await createFixtureRepo();
    const { ensurePlaywrightInstalled, validateRepositoryStructure } = await import("../src/tug/repo/validator.js");

    await writeFile(
      repoDir,
      "node_modules/@playwright/test/package.json",
      JSON.stringify({ name: "@playwright/test", version: "1.54.2" })
    );

    const repo = await validateRepositoryStructure(repoDir);
    await expect(ensurePlaywrightInstalled(repo)).resolves.toBe("1.54.2");

    expect(shellMocks.runShellCommand).not.toHaveBeenCalled();
  });
});
