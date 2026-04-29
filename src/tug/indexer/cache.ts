import path from "node:path";
import { promises as fs } from "node:fs";

import type { IndexData } from "../common/types.js";
import { resolveCacheRoot } from "../common/paths.js";

const resolveIndexRoot = () => path.join(resolveCacheRoot(), "indexes");

export const resolveIndexCachePath = (fingerprint: string) =>
  path.join(resolveIndexRoot(), `${fingerprint}.json`);

export const loadIndexCache = async (fingerprint: string): Promise<IndexData | null> => {
  const cachePath = resolveIndexCachePath(fingerprint);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw) as IndexData;
  } catch {
    return null;
  }
};

export const saveIndexCache = async (index: IndexData) => {
  const cachePath = resolveIndexCachePath(index.fingerprint);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return cachePath;
};

