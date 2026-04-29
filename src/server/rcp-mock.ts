import { TugError } from "../tug/common/errors.js";
import { tugLog } from "../tug/common/logger.js";
import { runShellCommand, type ShellResult } from "../tug/common/shell.js";

const RCP_MOCK_REPOSITORY = "redislabsdev/cloud-automation";
const RCP_MOCK_WORKFLOW = ".github/workflows/rcp-mock.yml";
const RCP_MOCK_WORKFLOW_ID = "108625572";
const RCP_MOCK_REF = "develop";
const RCP_MOCK_TYPE = "rcp-mock";
const RCP_MOCK_NAMESPACE = "k8s-integration";
const RCP_MOCK_API_VERSION = "2026-03-10";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

const NON_TERMINAL_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending"
]);

type GhCommandRunner = (command: string[]) => Promise<ShellResult>;
type SleepFn = (delayMs: number) => Promise<void>;
type NowFn = () => number;

type DispatchPayload = {
  workflow_run_id?: number;
  html_url?: string;
};

type RunPayload = {
  id?: number;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
};

export type RcpMockRunResult = {
  runId: number;
  runUrl: string;
};

export type WaitForRcpMockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  runCommand?: GhCommandRunner;
  sleep?: SleepFn;
  now?: NowFn;
};

const defaultSleep: SleepFn = async (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const defaultRunCommand: GhCommandRunner = async (command) =>
  runShellCommand({
    command,
    cwd: process.cwd(),
    env: process.env
  });

const formatShellErrorDetails = (result: ShellResult): string[] => {
  const details: string[] = [];
  if (result.stderr.trim().length > 0) {
    details.push(result.stderr.trim());
  }
  if (result.stdout.trim().length > 0) {
    details.push(result.stdout.trim());
  }
  if (details.length === 0) {
    details.push(`Command exited with code ${result.exitCode}.`);
  }
  return details;
};

const parseJsonPayload = <T>(payload: string, source: string): T => {
  try {
    return JSON.parse(payload) as T;
  } catch {
    throw new TugError(
      "EXECUTION_FAILED",
      `Unable to parse JSON returned by ${source}.`,
      payload.trim().length > 0 ? [payload.trim()] : []
    );
  }
};

export const enableRcpMockAndWait = async ({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  runCommand = defaultRunCommand,
  sleep = defaultSleep,
  now = () => Date.now()
}: WaitForRcpMockOptions = {}): Promise<RcpMockRunResult> => {
  tugLog("rcpMock.start", {
    repository: RCP_MOCK_REPOSITORY,
    workflow: RCP_MOCK_WORKFLOW,
    ref: RCP_MOCK_REF,
    timeoutMs,
    pollIntervalMs
  });

  const dispatchResult = await runCommand([
    "gh",
    "api",
    "-X",
    "POST",
    `repos/${RCP_MOCK_REPOSITORY}/actions/workflows/${RCP_MOCK_WORKFLOW_ID}/dispatches`,
    "-H",
    `X-GitHub-Api-Version: ${RCP_MOCK_API_VERSION}`,
    "-F",
    `ref=${RCP_MOCK_REF}`,
    "-F",
    "return_run_details=true",
    "-f",
    `inputs[rcp_type]=${RCP_MOCK_TYPE}`,
    "-f",
    `inputs[namespace]=${RCP_MOCK_NAMESPACE}`,
    "-F",
    "inputs[send_slack_notification]=true"
  ]);

  if (dispatchResult.exitCode !== 0) {
    throw new TugError(
      "EXECUTION_FAILED",
      "Failed to trigger the RCP mock workflow.",
      formatShellErrorDetails(dispatchResult)
    );
  }

  const dispatchPayload = parseJsonPayload<DispatchPayload>(
    dispatchResult.stdout,
    "the RCP mock workflow dispatch"
  );

  const runId =
    typeof dispatchPayload.workflow_run_id === "number"
      ? dispatchPayload.workflow_run_id
      : undefined;
  const runUrl =
    typeof dispatchPayload.html_url === "string" && dispatchPayload.html_url.length > 0
      ? dispatchPayload.html_url
      : undefined;

  if (!runId || !runUrl) {
    throw new TugError(
      "EXECUTION_FAILED",
      "RCP mock workflow dispatch response did not include run details.",
      dispatchResult.stdout.trim().length > 0 ? [dispatchResult.stdout.trim()] : []
    );
  }

  tugLog("rcpMock.dispatched", {
    runId,
    runUrl
  });

  const startedAt = now();

  while (true) {
    if (now() - startedAt >= timeoutMs) {
      throw new TugError(
        "EXECUTION_FAILED",
        `Timed out waiting for RCP mock workflow after ${Math.round(timeoutMs / 1000)} seconds.`,
        [`Run: ${runUrl}`]
      );
    }

    const runResult = await runCommand([
      "gh",
      "api",
      `repos/${RCP_MOCK_REPOSITORY}/actions/runs/${runId}`,
      "-H",
      `X-GitHub-Api-Version: ${RCP_MOCK_API_VERSION}`,
      "--jq",
      "{id:.id,status:.status,conclusion:.conclusion,html_url:.html_url}"
    ]);

    if (runResult.exitCode !== 0) {
      throw new TugError(
        "EXECUTION_FAILED",
        "Failed while checking RCP mock workflow status.",
        formatShellErrorDetails(runResult)
      );
    }

    const runPayload = parseJsonPayload<RunPayload>(
      runResult.stdout,
      "the RCP mock workflow status"
    );

    const status = typeof runPayload.status === "string" ? runPayload.status : "unknown";
    const conclusion =
      typeof runPayload.conclusion === "string" || runPayload.conclusion === null
        ? runPayload.conclusion
        : null;

    tugLog("rcpMock.poll", {
      runId,
      status,
      conclusion
    });

    if (status === "completed") {
      if (conclusion === "success") {
        tugLog("rcpMock.success", {
          runId,
          runUrl,
          durationMs: now() - startedAt
        });
        return {
          runId,
          runUrl
        };
      }

      throw new TugError(
        "EXECUTION_FAILED",
        `RCP mock workflow completed with conclusion: ${conclusion ?? "unknown"}.`,
        [`Run: ${runUrl}`]
      );
    }

    if (!NON_TERMINAL_STATUSES.has(status)) {
      throw new TugError(
        "EXECUTION_FAILED",
        `RCP mock workflow returned an unexpected status: ${status}.`,
        [`Run: ${runUrl}`]
      );
    }

    await sleep(pollIntervalMs);
  }
};
