import path from "node:path";
import { constants as fsConstants, promises as fs } from "node:fs";

import type { ProviderOption } from "../shared/contracts.js";
import type { AIProvider, ProviderBackend } from "../shared/config.js";

type ProviderCatalogResult = {
  providers: ProviderOption[];
  warnings: string[];
};

type CommandResolver = (command: string, env?: NodeJS.ProcessEnv) => Promise<string | undefined>;

const PROVIDER_LABELS: Record<AIProvider, string> = {
  augment: "Augment",
  codex: "Codex",
  cursor: "Cursor"
};

const accessExecutable = async (candidatePath: string) => {
  try {
    await fs.access(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const findCommandPath: CommandResolver = async (
  command,
  env = process.env
) => {
  const pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    if (await accessExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

export const buildProviderCatalog = async ({
  env = process.env,
  commandResolver = findCommandPath
}: {
  env?: NodeJS.ProcessEnv;
  commandResolver?: CommandResolver;
} = {}): Promise<ProviderCatalogResult> => {
  const warnings = new Set<string>();
  const providers: ProviderOption[] = [];

  const auggiePath =
    (env.AUGGIE_PATH && (await accessExecutable(env.AUGGIE_PATH)) && env.AUGGIE_PATH) ||
    (await commandResolver("auggie", env));
  const codexPath = await commandResolver("codex", env);
  const cursorPath =
    (env.CURSOR_CLI_PATH && (await accessExecutable(env.CURSOR_CLI_PATH)) && env.CURSOR_CLI_PATH) ||
    (await commandResolver("cursor-agent", env)) ||
    (await commandResolver("cursor-cli", env)) ||
    (await commandResolver("cursor-agent-cli", env));

  const augmentBackends: ProviderBackend[] = [];
  const augmentWarnings: string[] = [];

  if (env.AUGMENT_API_TOKEN?.trim()) {
    augmentBackends.push("augment-sdk");
  } else {
    augmentWarnings.push("Direct Augment SDK is unavailable because AUGMENT_API_TOKEN is not set.");
  }

  if (auggiePath) {
    augmentBackends.push("augment-auggie");
    if (!env.AUGMENT_API_TOKEN?.trim()) {
      augmentWarnings.push("Augment will fall back to the local auggie backend.");
    }
  } else {
    augmentWarnings.push("Auggie CLI was not found in PATH, so the fallback backend is unavailable.");
  }

  providers.push({
    id: "augment",
    label: PROVIDER_LABELS.augment,
    available: augmentBackends.length > 0,
    availableBackends: augmentBackends,
    defaultBackend: augmentBackends[0],
    warnings: augmentWarnings,
    reason:
      augmentBackends.length > 0
        ? undefined
        : "Set AUGMENT_API_TOKEN for direct SDK access or install/login to auggie for the fallback backend."
  });

  providers.push({
    id: "codex",
    label: PROVIDER_LABELS.codex,
    available: Boolean(codexPath),
    availableBackends: codexPath ? ["codex-cli"] : [],
    defaultBackend: codexPath ? "codex-cli" : undefined,
    warnings: codexPath ? [] : ["Codex CLI was not found in PATH."],
    reason: codexPath ? undefined : "Install or expose the codex CLI in PATH."
  });

  providers.push({
    id: "cursor",
    label: PROVIDER_LABELS.cursor,
    available: false,
    availableBackends: [],
    warnings: cursorPath
      ? [
          "A Cursor executable was detected, but user-generator does not yet have a supported Cursor backend."
        ]
      : ["Cursor remains disabled because no supported backend was detected."],
    reason:
      "Cursor is intentionally disabled until user-generator has a concrete Cursor execution backend."
  });

  const unavailableProviders = providers
    .filter((provider) => !provider.available)
    .map((provider) => provider.id);
  if (unavailableProviders.length > 0) {
    warnings.add(
      `Unavailable providers were detected and will stay disabled: ${unavailableProviders.join(", ")}`
    );
  }

  return {
    providers,
    warnings: [...warnings].sort()
  };
};
