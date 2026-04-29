import path from "node:path";
import { promises as fs } from "node:fs";

import { listSandboxDirectories } from "../../common/paths.js";
import { printResult } from "../../common/output.js";

export const runGcCommand = async (options: {
  maxAgeDays?: string;
  json?: boolean;
}) => {
  const maxAgeDays = Number(options.maxAgeDays ?? "7");
  const ageMs = (Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 7) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const sandboxDirs = await listSandboxDirectories();
  const deleted: string[] = [];
  const kept: string[] = [];

  for (const sandboxPath of sandboxDirs) {
    const stats = await fs.stat(sandboxPath).catch(() => undefined);
    if (!stats) {
      continue;
    }

    if (now - stats.mtimeMs > ageMs) {
      await fs.rm(sandboxPath, { recursive: true, force: true });
      deleted.push(sandboxPath);
    } else {
      kept.push(sandboxPath);
    }
  }

  const payload = {
    ok: true,
    maxAgeDays: ageMs / (24 * 60 * 60 * 1000),
    deletedCount: deleted.length,
    keptCount: kept.length,
    deleted,
    kept
  };

  printResult({
    json: Boolean(options.json),
    payload,
    text: [
      `GC complete. Deleted ${deleted.length} sandbox director${deleted.length === 1 ? "y" : "ies"}.`,
      `Kept ${kept.length} recent sandbox director${kept.length === 1 ? "y" : "ies"}.`,
      ...deleted.map((directory) => `- ${path.basename(directory)}`)
    ].join("\n")
  });
};

