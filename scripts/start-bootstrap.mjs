#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

const runOrExit = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const nodeModulesPath = path.resolve(process.cwd(), "node_modules");

if (!existsSync(nodeModulesPath)) {
  process.stdout.write("node_modules missing; installing dependencies with npm ci...\n");
  runOrExit(NPM_COMMAND, ["ci"]);
} else {
  process.stdout.write("node_modules already present; skipping npm ci.\n");
}

runOrExit(NPM_COMMAND, ["run", "build"]);
runOrExit("node", ["dist/cli/main.js", "setup"]);
