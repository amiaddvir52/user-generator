#!/usr/bin/env node
import { runSetupServerCli } from "./setup.js";

runSetupServerCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

