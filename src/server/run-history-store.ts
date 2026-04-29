import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";

import type { RunHistoryEntry } from "../shared/contracts.js";
import { resolveConfigDirectory } from "./config-store.js";

export const RUN_HISTORY_FILE_VERSION = 1;
export const RUN_HISTORY_MAX_ENTRIES = 50;

type RunHistoryStoreOptions = {
  configDir?: string;
  maxEntries?: number;
};

const RunHistoryEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  request: z.object({
    prompt: z.string().min(1).optional(),
    spec: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
    environment: z.string().min(1),
    executionMode: z.enum(["fast", "full"]).default("full"),
    allowAutoFallback: z.boolean().default(true),
    enableRcpMock: z.boolean(),
    trustUnknown: z.boolean(),
    trustUncertainTeardown: z.boolean(),
    keepSandbox: z.boolean(),
    reindex: z.boolean()
  }),
  result: z.object({
    fingerprint: z.string().min(1),
    compatibility: z.enum(["supported", "experimental"]),
    selectedTest: z.object({
      filePath: z.string().min(1),
      title: z.string().min(1)
    }),
    environment: z.string().min(1),
    executionMode: z.enum(["fast", "full"]).default("full"),
    fallbackTriggered: z.boolean().default(false),
    confidence: z.number(),
    sandboxPath: z.string().min(1),
    credentials: z.record(z.string(), z.string().optional()),
    warnings: z.array(z.string())
  })
});

const RunHistoryFileSchema = z.object({
  version: z.literal(RUN_HISTORY_FILE_VERSION),
  entries: z.array(RunHistoryEntrySchema)
});

type RunHistoryFile = z.infer<typeof RunHistoryFileSchema>;

const getPaths = (options: RunHistoryStoreOptions = {}) => {
  const configDir = options.configDir ?? resolveConfigDirectory();
  return {
    configDir,
    historyFile: path.join(configDir, "run-history.json")
  };
};

const writeHistoryAtomically = async (historyFile: string, payload: RunHistoryFile) => {
  await fs.mkdir(path.dirname(historyFile), { recursive: true });

  const tempFile = `${historyFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, historyFile);
};

const normalizeEntries = (entries: RunHistoryEntry[], maxEntries: number): RunHistoryEntry[] =>
  entries.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, maxEntries);

export const createRunHistoryStore = (options: RunHistoryStoreOptions = {}) => {
  const maxEntries = options.maxEntries ?? RUN_HISTORY_MAX_ENTRIES;
  const paths = getPaths(options);

  const load = async (): Promise<RunHistoryEntry[]> => {
    try {
      const raw = await fs.readFile(paths.historyFile, "utf8");
      const parsed = JSON.parse(raw);
      const file = RunHistoryFileSchema.parse(parsed);
      return normalizeEntries(file.entries as RunHistoryEntry[], maxEntries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      return [];
    }
  };

  const save = async (entries: RunHistoryEntry[]): Promise<RunHistoryEntry[]> => {
    const normalized = normalizeEntries(entries, maxEntries);
    const payload: RunHistoryFile = {
      version: RUN_HISTORY_FILE_VERSION,
      entries: normalized
    };
    await writeHistoryAtomically(paths.historyFile, payload);
    return normalized;
  };

  const append = async (entry: RunHistoryEntry): Promise<RunHistoryEntry[]> => {
    const currentEntries = await load();
    return save([entry, ...currentEntries]);
  };

  const reset = async () => {
    await fs.rm(paths.historyFile, { force: true });
  };

  return {
    append,
    load,
    reset,
    save,
    maxEntries,
    paths
  };
};
