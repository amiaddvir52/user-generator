import { describe, expect, it, vi } from "vitest";

import { TugError } from "../tug/common/errors.js";
import type { ShellResult } from "../tug/common/shell.js";
import { enableRcpMockAndWait } from "./rcp-mock.js";

const createShellResult = ({
  stdout = "",
  stderr = "",
  exitCode = 0
}: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): ShellResult => ({
  command: [],
  cwd: "/tmp",
  stdout,
  stderr,
  exitCode
});

describe("enableRcpMockAndWait", () => {
  it("dispatches and waits until the workflow run succeeds", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(
        createShellResult({
          stdout: '{"workflow_run_id":123,"html_url":"https://github.com/redislabsdev/cloud-automation/actions/runs/123"}'
        })
      )
      .mockResolvedValueOnce(
        createShellResult({
          stdout: '{"id":123,"status":"queued","conclusion":null,"html_url":"https://github.com/redislabsdev/cloud-automation/actions/runs/123"}'
        })
      )
      .mockResolvedValueOnce(
        createShellResult({
          stdout: '{"id":123,"status":"completed","conclusion":"success","html_url":"https://github.com/redislabsdev/cloud-automation/actions/runs/123"}'
        })
      );

    let currentTime = 0;
    const now = () => currentTime;
    const sleep = async (delayMs: number) => {
      currentTime += delayMs;
    };

    const result = await enableRcpMockAndWait({
      runCommand,
      now,
      sleep,
      timeoutMs: 90_000,
      pollIntervalMs: 3_000
    });

    expect(result).toEqual({
      runId: 123,
      runUrl: "https://github.com/redislabsdev/cloud-automation/actions/runs/123"
    });

    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(runCommand.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "gh",
        "api",
        "-X",
        "POST",
        "repos/redislabsdev/cloud-automation/actions/workflows/108625572/dispatches",
        "-F",
        "ref=develop",
        "-F",
        "return_run_details=true",
        "-f",
        "inputs[rcp_type]=rcp-mock",
        "-f",
        "inputs[namespace]=k8s-integration",
        "-F",
        "inputs[send_slack_notification]=true"
      ])
    );
  });

  it("fails when dispatch command fails", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(
      createShellResult({
        exitCode: 1,
        stderr: "HTTP 401"
      })
    );

    await expect(enableRcpMockAndWait({ runCommand })).rejects.toMatchObject({
      message: "Failed to trigger the RCP mock workflow.",
      reason: "EXECUTION_FAILED"
    });
  });

  it("fails when the workflow completes with a non-success conclusion", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(
        createShellResult({
          stdout: '{"workflow_run_id":123,"html_url":"https://github.com/redislabsdev/cloud-automation/actions/runs/123"}'
        })
      )
      .mockResolvedValueOnce(
        createShellResult({
          stdout: '{"id":123,"status":"completed","conclusion":"failure","html_url":"https://github.com/redislabsdev/cloud-automation/actions/runs/123"}'
        })
      );

    await expect(
      enableRcpMockAndWait({
        runCommand,
        sleep: async () => undefined,
        now: () => 0
      })
    ).rejects.toMatchObject({
      message: "RCP mock workflow completed with conclusion: failure.",
      reason: "EXECUTION_FAILED"
    });
  });

  it("fails with timeout when the workflow does not complete in time", async () => {
    const runCommand = vi.fn(async () =>
      createShellResult({
        stdout:
          '{"id":123,"status":"in_progress","conclusion":null,"html_url":"https://github.com/redislabsdev/cloud-automation/actions/runs/123"}'
      })
    );

    runCommand.mockResolvedValueOnce(
      createShellResult({
        stdout: '{"workflow_run_id":123,"html_url":"https://github.com/redislabsdev/cloud-automation/actions/runs/123"}'
      })
    );

    let currentTime = 0;
    const now = () => currentTime;
    const sleep = async (delayMs: number) => {
      currentTime += delayMs;
    };

    await expect(
      enableRcpMockAndWait({
        runCommand,
        now,
        sleep,
        timeoutMs: 90_000,
        pollIntervalMs: 30_000
      })
    ).rejects.toMatchObject({
      message: "Timed out waiting for RCP mock workflow after 90 seconds.",
      reason: "EXECUTION_FAILED"
    });
  });

  it("fails when dispatch response does not include run details", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(
      createShellResult({
        stdout: '{"ok":true}'
      })
    );

    const promise = enableRcpMockAndWait({ runCommand });

    await expect(promise).rejects.toBeInstanceOf(TugError);
    await expect(promise).rejects.toMatchObject({
      message: "RCP mock workflow dispatch response did not include run details.",
      reason: "EXECUTION_FAILED"
    });
  });
});
