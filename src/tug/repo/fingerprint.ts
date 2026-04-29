import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Project, SyntaxKind } from "ts-morph";

import type { FingerprintInfo, RepoHandle } from "../common/types.js";

const HELPER_ROOT_RELATIVE = "e2e-automation/sm-ui-refresh/playwright-helpers/sm";

const createHash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

const normalizeConfigText = (value: string) =>
  value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();

const walkFiles = async (rootPath: string): Promise<string[]> => {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
};

const collectExportSymbols = async (files: string[]) => {
  const project = new Project({
    skipAddingFilesFromTsConfig: true
  });

  files.forEach((filePath) => {
    project.addSourceFileAtPath(filePath);
  });

  const exportMap: Record<string, string[]> = {};

  project.getSourceFiles().forEach((sourceFile) => {
    const exports = new Set<string>();

    sourceFile.getExportedDeclarations().forEach((declarations, exportName) => {
      if (exportName === "default") {
        exports.add("default");
        return;
      }

      if (declarations.length > 0) {
        exports.add(exportName);
      }
    });

    sourceFile
      .getDescendantsOfKind(SyntaxKind.VariableStatement)
      .filter((statement) => statement.isExported())
      .forEach((statement) => {
        statement.getDeclarations().forEach((declaration) => {
          const name = declaration.getName();
          if (name) {
            exports.add(name);
          }
        });
      });

    exportMap[sourceFile.getFilePath()] = [...exports].sort();
  });

  return exportMap;
};

const extractMajorVersion = (rawVersion?: string) => {
  if (!rawVersion) {
    return undefined;
  }

  const match = rawVersion.match(/(\d+)/);
  return match ? Number(match[1]) : undefined;
};

const parseMajorFromLockfile = async (lockfilePath?: string) => {
  if (!lockfilePath) {
    return {
      playwrightMajor: undefined,
      typescriptMajor: undefined
    };
  }

  const lockfile = await fs.readFile(lockfilePath, "utf8");

  const playwrightMatch =
    lockfile.match(/\/@playwright\/test@([^:\n]+):/) ??
    lockfile.match(/"@playwright\/test"\s*:\s*"([^"]+)"/);
  const typescriptMatch =
    lockfile.match(/\/typescript@([^:\n]+):/) ??
    lockfile.match(/"typescript"\s*:\s*"([^"]+)"/);

  return {
    playwrightMajor: extractMajorVersion(playwrightMatch?.[1]),
    typescriptMajor: extractMajorVersion(typescriptMatch?.[1])
  };
};

export const computeFingerprint = async (repo: RepoHandle): Promise<FingerprintInfo> => {
  const helpersRootPath = path.join(repo.absPath, HELPER_ROOT_RELATIVE);
  const helperFilesAbsolute = (await walkFiles(helpersRootPath))
    .filter((filePath) => filePath.endsWith(".ts"))
    .sort((left, right) => left.localeCompare(right));

  const helperFiles = helperFilesAbsolute.map((filePath) =>
    path.relative(repo.absPath, filePath).replace(/\\/g, "/")
  );

  const helperExportsAbsolute = await collectExportSymbols(helperFilesAbsolute);
  const helperExports = Object.fromEntries(
    Object.entries(helperExportsAbsolute)
      .map(
        ([absolutePath, exports]): [string, string[]] => [
          path.relative(repo.absPath, absolutePath).replace(/\\/g, "/"),
          exports
        ]
      )
      .sort((left, right) => left[0].localeCompare(right[0]))
  );

  const playwrightConfigRaw = await fs.readFile(repo.playwrightConfigPath, "utf8");
  const structuralPlaywrightConfigHash = createHash(normalizeConfigText(playwrightConfigRaw));

  const lockfileMajors = await parseMajorFromLockfile(repo.lockfilePath);

  const hashInputs = {
    helperFiles,
    helperExports,
    structuralPlaywrightConfigHash,
    packageName: repo.packageName,
    packageVersion: repo.packageVersion,
    playwrightMajor: lockfileMajors.playwrightMajor,
    typescriptMajor: lockfileMajors.typescriptMajor
  };

  const digest = createHash(JSON.stringify(hashInputs));

  return {
    fingerprint: `fp_${digest.slice(0, 7)}`,
    helperFiles,
    helperExports,
    packageName: repo.packageName,
    packageVersion: repo.packageVersion,
    playwrightMajor: lockfileMajors.playwrightMajor,
    typescriptMajor: lockfileMajors.typescriptMajor,
    hashInputs
  };
};
