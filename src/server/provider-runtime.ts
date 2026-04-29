import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { Auggie } from "@augmentcode/auggie-sdk";

import type { AIProvider, ProviderBackend } from "../shared/config.js";
import { buildProviderCatalog, findCommandPath } from "./provider-catalog.js";

const execFileAsync = promisify(execFile);

export type ProviderExecutionInput = {
  backend: ProviderBackend;
  environment: string;
  prompt: string;
  provider: AIProvider;
  repositoryPath: string;
};

export type ProviderExecutionOutput = {
  output: string;
  warnings: string[];
};

const buildExecutionPrompt = ({
  environment,
  prompt,
  repositoryPath
}: Pick<ProviderExecutionInput, "environment" | "prompt" | "repositoryPath">) =>
  [
    `You are working inside the automation repository at ${repositoryPath}.`,
    `Target environment: ${environment}.`,
    prompt.trim()
  ].join("\n\n");

const createAugmentClient = async (options: Record<string, unknown>) => {
  const augmentSdk = Auggie as unknown as {
    create(input: Record<string, unknown>): Promise<{
      close?: () => Promise<void>;
      prompt: (value: string) => Promise<string>;
    }>;
  };

  return augmentSdk.create(options);
};

const executeWithAugment = async (
  input: ProviderExecutionInput
): Promise<ProviderExecutionOutput> => {
  if (input.backend === "augment-sdk" && !process.env.AUGMENT_API_TOKEN?.trim()) {
    throw new Error("AUGMENT_API_TOKEN is required for the direct Augment SDK backend.");
  }

  if (
    input.backend === "augment-auggie" &&
    !(process.env.AUGGIE_PATH?.trim() || (await findCommandPath("auggie")))
  ) {
    throw new Error("Auggie CLI was not found in PATH.");
  }

  const client = await createAugmentClient(
    input.backend === "augment-sdk"
      ? {
          model: process.env.AUGMENT_MODEL?.trim() || "sonnet4.5",
          apiKey: process.env.AUGMENT_API_TOKEN,
          ...(process.env.AUGMENT_API_URL?.trim()
            ? { apiUrl: process.env.AUGMENT_API_URL.trim() }
            : {})
        }
      : {
          auggiePath: process.env.AUGGIE_PATH?.trim() || (await findCommandPath("auggie")),
          workspaceRoot: input.repositoryPath
        }
  );

  try {
    const output = await client.prompt(
      buildExecutionPrompt({
        environment: input.environment,
        prompt: input.prompt,
        repositoryPath: input.repositoryPath
      })
    );

    return {
      output,
      warnings:
        input.backend === "augment-auggie"
          ? ["Using the auggie fallback backend because the direct Augment SDK was not selected."]
          : []
    };
  } finally {
    await client.close?.();
  }
};

const executeWithCodex = async (
  input: ProviderExecutionInput
): Promise<ProviderExecutionOutput> => {
  const codexPath = await findCommandPath("codex");
  if (!codexPath) {
    throw new Error("Codex CLI was not found in PATH.");
  }

  const outputFile = path.join(
    os.tmpdir(),
    `user-generator-codex-${process.pid}-${Date.now()}.txt`
  );
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--output-last-message",
    outputFile,
    "-C",
    input.repositoryPath,
    buildExecutionPrompt({
      environment: input.environment,
      prompt: input.prompt,
      repositoryPath: input.repositoryPath
    })
  ];

  try {
    const { stdout } = await execFileAsync(codexPath, args, {
      maxBuffer: 1_000_000,
      timeout: 120_000
    });
    const output = await fs
      .readFile(outputFile, "utf8")
      .then((value) => value.trim())
      .catch(() => stdout.trim());

    return {
      output,
      warnings: []
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };
    const message =
      execError.stderr?.trim() || execError.stdout?.trim() || execError.message;
    throw new Error(message);
  } finally {
    await fs.rm(outputFile, { force: true }).catch(() => undefined);
  }
};

export const executeProviderPrompt = async (
  input: ProviderExecutionInput
): Promise<ProviderExecutionOutput> => {
  const providerCatalog = await buildProviderCatalog();
  const selectedProvider = providerCatalog.providers.find(
    (provider) => provider.id === input.provider
  );

  if (!selectedProvider?.availableBackends.includes(input.backend)) {
    throw new Error(
      `Configured backend ${input.backend} is no longer available for ${input.provider}.`
    );
  }

  switch (input.backend) {
    case "augment-sdk":
    case "augment-auggie":
      return executeWithAugment(input);
    case "codex-cli":
      return executeWithCodex(input);
    default:
      throw new Error(`Unsupported provider backend: ${input.backend}`);
  }
};
