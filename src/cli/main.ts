#!/usr/bin/env node
import path from "node:path";

import { runSetupServerCli } from "../server/setup.js";
import { printErrorAndExit } from "../tug/common/output.js";
import { createTugProgram } from "../tug/cli/program.js";

const run = async () => {
  const invokedBinary = path.basename(process.argv[1] ?? "tug");
  const args = process.argv.slice(2);

  if (invokedBinary !== "tug" && (args.length === 0 || args[0] === "setup")) {
    const setupArgs = args[0] === "setup" ? args.slice(1) : args;
    await runSetupServerCli(setupArgs);
    return;
  }

  if (invokedBinary === "tug" && args[0] === "setup") {
    process.stderr.write("`tug` does not support setup UI mode. Use `user-generator setup`.\n");
    process.exit(1);
  }

  const program = createTugProgram({
    commandName: invokedBinary === "tug" ? "tug" : "user-generator",
    includeSetupHint: invokedBinary !== "tug"
  });

  await program.parseAsync(args, {
    from: "user"
  });
};

run().catch((error) => {
  const wantsJson = process.argv.includes("--json");
  printErrorAndExit({
    json: wantsJson,
    error
  });
});
