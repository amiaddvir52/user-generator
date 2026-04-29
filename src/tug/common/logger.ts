import path from "node:path";
import { promises as fs } from "node:fs";

import { resolveCacheRoot } from "./paths.js";

const LOG_DIR_NAME = "logs";
const MAX_FIELD_BYTES = 4096;

let resolvedLogFilePath: string | undefined;
let initPromise: Promise<string> | undefined;

const sanitizeForFilename = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-");

const buildLogFilePath = () => {
  const stamp = sanitizeForFilename(new Date().toISOString());
  return path.join(resolveCacheRoot(), LOG_DIR_NAME, `tug-${stamp}-${process.pid}.log`);
};

const ensureLogFile = async (): Promise<string> => {
  if (resolvedLogFilePath) {
    return resolvedLogFilePath;
  }
  if (!initPromise) {
    initPromise = (async () => {
      const filePath = process.env.TUG_LOG_FILE && process.env.TUG_LOG_FILE.length > 0
        ? process.env.TUG_LOG_FILE
        : buildLogFilePath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      resolvedLogFilePath = filePath;
      return filePath;
    })().catch((error) => {
      initPromise = undefined;
      throw error;
    });
  }
  return initPromise;
};

export const truncate = (value: unknown, maxBytes = MAX_FIELD_BYTES): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const head = value.slice(0, maxBytes);
  const omittedBytes = Buffer.byteLength(value, "utf8") - Buffer.byteLength(head, "utf8");
  return `${head}\n…[truncated ${omittedBytes} bytes]`;
};

const sanitizePayload = (payload: Record<string, unknown> | undefined) => {
  if (!payload) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = truncate(value);
  }
  return out;
};

export const tugLog = (event: string, payload?: Record<string, unknown>) => {
  const entry = {
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...sanitizePayload(payload)
  };
  let line: string;
  try {
    line = `${JSON.stringify(entry)}\n`;
  } catch {
    line = `${JSON.stringify({ ts: entry.ts, pid: entry.pid, event, error: "payload_unserializable" })}\n`;
  }

  void ensureLogFile()
    .then((filePath) => fs.appendFile(filePath, line, "utf8"))
    .catch(() => undefined);
};

export const getLogFilePath = () => resolvedLogFilePath;

export const ensureLoggerReady = async () => ensureLogFile();

export const resetLoggerForTesting = () => {
  resolvedLogFilePath = undefined;
  initPromise = undefined;
};
