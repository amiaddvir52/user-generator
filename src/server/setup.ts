import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import open from "open";

import { buildApp } from "./app.js";
import { ensureLoggerReady } from "../tug/common/logger.js";

type CliOptions = {
  openBrowser: boolean;
  port: number;
};

const parseArgs = (args: string[]): CliOptions => {
  const options: CliOptions = {
    openBrowser: true,
    port: 0
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (value === "--no-open") {
      options.openBrowser = false;
      continue;
    }

    if (value === "--port") {
      const portValue = Number(args[index + 1]);

      if (Number.isNaN(portValue) || portValue < 0) {
        throw new Error("Expected a valid numeric port after --port.");
      }

      options.port = portValue;
      index += 1;
    }
  }

  return options;
};

const resolveWebRoot = async () => {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const candidate = path.resolve(currentDir, "..", "web");

  await fs.access(candidate);
  return candidate;
};

export const runSetupServerCli = async (args: string[]) => {
  const cliOptions = parseArgs(args);
  const webRoot = await resolveWebRoot().catch(() => {
    throw new Error("Web assets were not found. Run `npm run build` before starting User Generator.");
  });

  const app = await buildApp({ webRoot });
  const address = await app.listen({
    host: "127.0.0.1",
    port: cliOptions.port
  });

  process.on("SIGINT", async () => {
    await app.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await app.close();
    process.exit(0);
  });

  if (cliOptions.openBrowser) {
    await open(address);
  }

  process.stdout.write(`User Generator is running at ${address}\n`);

  const logFilePath = await ensureLoggerReady().catch(() => undefined);
  if (logFilePath) {
    process.stdout.write(`Run log: ${logFilePath}\n`);
  }
};

