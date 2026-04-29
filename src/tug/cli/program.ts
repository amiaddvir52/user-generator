import { Command } from "commander";

import { runDryRunCommand } from "./commands/dry-run.js";
import { runExplainCommand } from "./commands/explain.js";
import { runExplainTeardownsCommand } from "./commands/explain-teardowns.js";
import { runGcCommand } from "./commands/gc.js";
import { runIndexCommand } from "./commands/index.js";
import { runRunCommand } from "./commands/run.js";
import { runValidateCommand } from "./commands/validate.js";

const withRepoOption = (command: Command) =>
  command.option("--repo <path>", "Path to target automation repository.");

const withSafetyOptions = (command: Command) =>
  command
    .option("--strict", "Block dirty working tree or unsafe states.")
    .option("--trust-unknown", "Allow unknown fingerprint in experimental mode.");

const withCommonOutputOptions = (command: Command) =>
  command.option("--json", "Emit machine-readable JSON output.");

export const createTugProgram = ({
  commandName,
  includeSetupHint
}: {
  commandName: string;
  includeSetupHint: boolean;
}) => {
  const program = new Command();
  program
    .name(commandName)
    .description("External fail-closed CLI for test user generation against a local automation clone.")
    .showHelpAfterError(true);

  if (includeSetupHint) {
    program.addHelpText(
      "after",
      "\nTip: run `user-generator setup` to open the onboarding UI for provider/repo/environment defaults."
    );
  }

  withCommonOutputOptions(withSafetyOptions(withRepoOption(program.command("validate"))))
    .description("Run repository and compatibility gates.")
    .action(async (options) => runValidateCommand(options));

  withCommonOutputOptions(withSafetyOptions(withRepoOption(program.command("index"))))
    .description("Build or load the fingerprint-keyed spec index.")
    .option("--reindex", "Force index rebuild.")
    .action(async (options) => runIndexCommand(options));

  withCommonOutputOptions(withSafetyOptions(withRepoOption(program.command("explain-teardowns"))))
    .description("Show dynamic teardown detection scores.")
    .option("--reindex", "Force index rebuild.")
    .action(async (options) => runExplainTeardownsCommand(options));

  withCommonOutputOptions(withSafetyOptions(withRepoOption(program.command("explain"))))
    .description("Rank candidate tests for a natural-language prompt.")
    .argument("<prompt>", "Prompt describing the desired provisioned state.")
    .option("--reindex", "Force index rebuild.")
    .option("--top <n>", "Number of candidates to show.")
    .action(async (prompt, options) => runExplainCommand(prompt, options));

  withCommonOutputOptions(withSafetyOptions(withRepoOption(program.command("dry-run"))))
    .description("Transform a selected spec/test into a sandbox and validate it.")
    .requiredOption("--spec <path>", "Spec file path.")
    .requiredOption("--test <title>", "Exact test title.")
    .option("--yes", "Auto-accept confirmations.")
    .option("--keep-sandbox", "Retain sandbox after completion.")
    .option("--reindex", "Force index rebuild.")
    .action(async (options) => runDryRunCommand(options));

  withCommonOutputOptions(withSafetyOptions(withRepoOption(program.command("run"))))
    .description("Select, transform, validate, and execute a sandboxed test.")
    .argument("[prompt]", "Prompt describing desired provisioned state.")
    .option("--spec <path>", "Explicit spec file path.")
    .option("--test <title>", "Explicit test title.")
    .option("--environment <value>", "Override environment for execution context.")
    .option("--yes", "Auto-accept confirmations.")
    .option("--keep-sandbox", "Retain sandbox after completion.")
    .option("--reindex", "Force index rebuild.")
    .option("--output <file>", "Write JSON output to file with mode 0600.")
    .option("--export-env", "Emit shell export lines for extracted credentials.")
    .action(async (prompt, options) => runRunCommand(prompt, options));

  withCommonOutputOptions(program.command("gc"))
    .description("Garbage collect old sandbox run directories.")
    .option("--max-age-days <days>", "Delete run directories older than this age.")
    .action(async (options) => runGcCommand(options));

  return program;
};

