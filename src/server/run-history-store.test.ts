import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { RunHistoryEntry } from "../shared/contracts.js";
import { createRunHistoryStore, RUN_HISTORY_FILE_VERSION } from "./run-history-store.js";

const tempRoots: string[] = [];

const createTempDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "user-generator-history-"));
  tempRoots.push(directory);
  return directory;
};

const createHistoryEntry = (id: string, createdAt: string): RunHistoryEntry => ({
  id,
  createdAt,
  request: {
    prompt: `prompt-${id}`,
    environment: "qa.qa",
    enableRcpMock: false,
    trustUnknown: true,
    trustUncertainTeardown: true,
    keepSandbox: false,
    reindex: false
  },
  result: {
    fingerprint: `fp-${id}`,
    compatibility: "supported",
    selectedTest: {
      filePath: `/tmp/${id}.spec.ts`,
      title: `creates ${id}`
    },
    environment: "qa.qa",
    confidence: 0.9,
    sandboxPath: `/tmp/sandbox-${id}`,
    credentials: {
      email: `${id}@example.com`,
      password: "secret"
    },
    warnings: []
  }
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("run history store", () => {
  it("returns empty history when file does not exist", async () => {
    const configDir = await createTempDir();
    const store = createRunHistoryStore({ configDir });

    await expect(store.load()).resolves.toEqual([]);
  });

  it("saves and reloads entries using persisted json", async () => {
    const configDir = await createTempDir();
    const store = createRunHistoryStore({ configDir });
    const first = createHistoryEntry("1", "2026-01-01T00:00:00.000Z");
    const second = createHistoryEntry("2", "2026-01-02T00:00:00.000Z");

    await store.save([first, second]);
    const loaded = await store.load();

    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("2");
    expect(loaded[1].id).toBe("1");

    const rawFile = await fs.readFile(store.paths.historyFile, "utf8");
    const parsed = JSON.parse(rawFile) as { version: number; entries: RunHistoryEntry[] };
    expect(parsed.version).toBe(RUN_HISTORY_FILE_VERSION);
    expect(parsed.entries).toHaveLength(2);
  });

  it("caps stored entries by maxEntries", async () => {
    const configDir = await createTempDir();
    const store = createRunHistoryStore({ configDir, maxEntries: 3 });

    for (let index = 0; index < 5; index += 1) {
      await store.append(
        createHistoryEntry(String(index), `2026-01-0${index + 1}T00:00:00.000Z`)
      );
    }

    const loaded = await store.load();
    expect(loaded).toHaveLength(3);
    expect(loaded.map((entry) => entry.id)).toEqual(["4", "3", "2"]);
  });

  it("falls back to empty on corruption and safely overwrites with next append", async () => {
    const configDir = await createTempDir();
    const store = createRunHistoryStore({ configDir });

    await fs.mkdir(path.dirname(store.paths.historyFile), { recursive: true });
    await fs.writeFile(store.paths.historyFile, "{not-json", "utf8");

    await expect(store.load()).resolves.toEqual([]);

    await store.append(createHistoryEntry("new", "2026-01-12T00:00:00.000Z"));

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("new");
  });
});
