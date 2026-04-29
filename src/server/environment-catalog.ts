import path from "node:path";
import { promises as fs } from "node:fs";

import type {
  EnvironmentCategory,
  EnvironmentOption
} from "../shared/contracts.js";
import {
  SUPPORTED_ENVIRONMENTS,
  SUPPORTED_ENVIRONMENT_RUNTIME_MAP
} from "../shared/supported-environments.js";

type EnvironmentCatalogResult = {
  environments: EnvironmentOption[];
  warnings: string[];
};

type SourceFamily = "enum" | "helper" | "ci";

type EnvironmentAccumulator = {
  categoryHints: Set<SourceFamily>;
  normalizedValue?: string;
  sources: Set<string>;
  warnings: Set<string>;
};

type ExtractedMatch = {
  line: number;
  value: string;
};

const ENVIRONMENT_PATTERN =
  /\b(?:sm\.[a-z0-9-]+\.sm-qa\.qa|(?:qa|aa|staging|integration|cloudapi)\.qa|gcp)\b/g;
const ENVIRONMENT_VALUE_PATTERN =
  /^(?:sm\.[a-z0-9-]+\.sm-qa\.qa|(?:qa|aa|staging|integration|cloudapi)\.qa|gcp)$/;

const SOURCE_PATHS = {
  enum: "e2e-automation/sm-ui-refresh/types/environments.ts",
  helperEnvironment: "e2e-automation/sm-ui-refresh/playwright-helpers/environment.ts",
  helperHttpClient: "packages/api-clients/http-client.ts",
  smEnvsClient: "packages/api-clients/http-clients/sm-envs-client.ts",
  featureFlagEnvs: "microservices/feature-flags/src/features/get-envs.ts",
  continuousIntegrationRoot: "e2e-automation/sm-ui-refresh/continuous-integration"
} as const;

const EXPLICIT_VARIANT_GROUPS = [
  ["qa.qa", "sm.k8s-dev-uirefresh.sm-qa.qa"],
  ["aa.qa", "sm.k8s-aa.sm-qa.qa"],
  ["gcp", "sm.k8s-gcp.sm-qa.qa"],
  ["cloudapi.qa", "sm.k8s-cloudapi.sm-qa.qa"]
] as const;

const resolveSourcePath = (automationRepoPath: string, relativePath: string) =>
  path.join(automationRepoPath, relativePath);

const createSourceRef = (relativePath: string, line: number) => `${relativePath}:${line}`;

const extractStringMatches = (line: string) => {
  const matches = [...line.matchAll(ENVIRONMENT_PATTERN)];
  return matches.map((match) => match[0]);
};

const isEnvironmentValue = (value: string) => ENVIRONMENT_VALUE_PATTERN.test(value);

const readFileLines = async (filePath: string) => {
  const contents = await fs.readFile(filePath, "utf8");
  return contents.split(/\r?\n/);
};

const collectObjectLiteralEntries = (lines: string[]) => {
  const entries: Array<{ key: string; value?: string; line: number }> = [];
  let inObject = false;

  lines.forEach((line, index) => {
    if (line.includes("const k8sDomains = {")) {
      inObject = true;
      return;
    }

    if (!inObject) {
      return;
    }

    if (line.includes("};")) {
      inObject = false;
      return;
    }

    const match =
      line.match(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/) ??
      line.match(/([A-Za-z0-9_.-]+)\s*:\s*['"]([^'"]+)['"]/);

    if (!match) {
      return;
    }

    const key = match[1];
    const value = match[2];
    entries.push({ key, value, line: index + 1 });
  });

  return entries;
};

const collectEnumEntries = (lines: string[]) => {
  const matches: ExtractedMatch[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/=\s*'([^']+)'/);
    if (!match) {
      return;
    }

    matches.push({
      line: index + 1,
      value: match[1]
    });
  });
  return matches;
};

const collectSpecialCaseEntries = (lines: string[]) => {
  const matches: ExtractedMatch[] = [];
  lines.forEach((line, index) => {
    if (
      !line.includes("env ===") &&
      !line.includes("envList =") &&
      !line.includes("envs.push")
    ) {
      return;
    }

    const values = extractStringMatches(line);
    values.forEach((value) => {
      matches.push({
        line: index + 1,
        value
      });
    });
  });
  return matches;
};

const countParens = (line: string) => {
  let depth = 0;
  for (const char of line) {
    if (char === "(") {
      depth += 1;
    }
    if (char === ")") {
      depth -= 1;
    }
  }

  return depth;
};

const collectCiChoiceEntries = (lines: string[]) => {
  const matches: ExtractedMatch[] = [];
  let buffer: string[] = [];
  let startLine = 0;
  let depth = 0;

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }

    const block = buffer.join("\n");
    if (!/name:\s*['"]env(?:ironments)?['"]/.test(block) || !/choices\s*:/.test(block)) {
      buffer = [];
      startLine = 0;
      depth = 0;
      return;
    }

    buffer.forEach((line, index) => {
      const values = extractStringMatches(line);
      if (values.length === 0) {
        return;
      }

      const hasConcreteEnvironment = values.some(
        (value) => value.includes(".qa") || value.startsWith("sm.")
      );
      if (!hasConcreteEnvironment) {
        return;
      }

      values.forEach((value) => {
        matches.push({
          line: startLine + index,
          value
        });
      });
    });

    buffer = [];
    startLine = 0;
    depth = 0;
  };

  lines.forEach((line, index) => {
    if (buffer.length === 0 && /\b(?:editableChoice|choice)\s*\(/.test(line)) {
      buffer = [line];
      startLine = index + 1;
      depth = countParens(line);
      if (depth <= 0) {
        flush();
      }
      return;
    }

    if (buffer.length === 0) {
      return;
    }

    buffer.push(line);
    depth += countParens(line);
    if (depth <= 0) {
      flush();
    }
  });

  flush();
  return matches;
};

const addEnvironmentEntry = (
  environments: Map<string, EnvironmentAccumulator>,
  value: string,
  family: SourceFamily,
  sourceRef: string,
  normalizedValue?: string
) => {
  const environment = environments.get(value) ?? {
    categoryHints: new Set<SourceFamily>(),
    sources: new Set<string>(),
    warnings: new Set<string>()
  };

  environment.categoryHints.add(family);
  environment.sources.add(sourceRef);

  if (normalizedValue && normalizedValue !== value) {
    environment.normalizedValue = normalizedValue;
    environment.warnings.add(`Helper alias resolves to ${normalizedValue}.`);
  }

  environments.set(value, environment);
};

const determineCategory = (
  value: string,
  environment: EnvironmentAccumulator
): EnvironmentCategory => {
  if (environment.normalizedValue && environment.normalizedValue !== value) {
    return "alias";
  }

  if (environment.categoryHints.has("enum")) {
    return "enum";
  }

  if (environment.categoryHints.has("helper")) {
    return "helper";
  }

  return "ci-only";
};

const mergeEnvironmentCategory = (
  current: EnvironmentCategory,
  next: EnvironmentCategory
): EnvironmentCategory => {
  if (current === "alias" || next === "alias") {
    return "alias";
  }
  if (current === "enum" || next === "enum") {
    return "enum";
  }
  if (current === "helper" || next === "helper") {
    return "helper";
  }

  return "ci-only";
};

const buildSupportedCatalog = (catalog: EnvironmentOption[]): EnvironmentOption[] => {
  const catalogByValue = new Map(catalog.map((environment) => [environment.value, environment]));

  return SUPPORTED_ENVIRONMENTS.map((supportedEnvironment) => {
    const runtimeValue = SUPPORTED_ENVIRONMENT_RUNTIME_MAP[supportedEnvironment];
    const matchingVariants = [supportedEnvironment, runtimeValue]
      .map((value) => catalogByValue.get(value))
      .filter(Boolean) as EnvironmentOption[];

    const category = matchingVariants.reduce<EnvironmentCategory>(
      (accumulator, environment) => mergeEnvironmentCategory(accumulator, environment.category),
      runtimeValue !== supportedEnvironment ? "alias" : "ci-only"
    );

    const normalizedValue =
      runtimeValue !== supportedEnvironment
        ? runtimeValue
        : matchingVariants.find((environment) => environment.normalizedValue)?.normalizedValue;

    const sources = new Set<string>();
    const warnings = new Set<string>();

    matchingVariants.forEach((environment) => {
      environment.sources.forEach((source) => sources.add(source));
      environment.warnings.forEach((warning) => warnings.add(warning));
    });

    return {
      value: supportedEnvironment,
      category: normalizedValue && normalizedValue !== supportedEnvironment ? "alias" : category,
      normalizedValue,
      sources: [...sources].sort(),
      warnings: [...warnings].sort()
    };
  });
};

const walkDirectory = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".groovy")) {
      files.push(entryPath);
    }
  }

  return files;
};

export const buildEnvironmentCatalog = async (
  automationRepoPath?: string
): Promise<EnvironmentCatalogResult> => {
  if (!automationRepoPath) {
    return {
      environments: [],
      warnings: []
    };
  }

  const environments = new Map<string, EnvironmentAccumulator>();
  const warnings = new Set<string>();

  const addMissingSourceWarning = (relativePath: string) => {
    warnings.add(`Environment source file was not found: ${relativePath}`);
  };

  try {
    const enumFile = resolveSourcePath(automationRepoPath, SOURCE_PATHS.enum);
    const enumLines = await readFileLines(enumFile);
    collectEnumEntries(enumLines).forEach(({ line, value }) => {
      addEnvironmentEntry(
        environments,
        value,
        "enum",
        createSourceRef(SOURCE_PATHS.enum, line)
      );
    });
  } catch {
    addMissingSourceWarning(SOURCE_PATHS.enum);
  }

  for (const [relativePath, sourceLabel] of [
    [SOURCE_PATHS.helperEnvironment, "helper"],
    [SOURCE_PATHS.helperHttpClient, "helper"]
  ] as const) {
    try {
      const fileLines = await readFileLines(resolveSourcePath(automationRepoPath, relativePath));
      collectObjectLiteralEntries(fileLines).forEach(({ key, value, line }) => {
        if (isEnvironmentValue(key)) {
          addEnvironmentEntry(
            environments,
            key,
            sourceLabel,
            createSourceRef(relativePath, line),
            value && isEnvironmentValue(value) ? value : undefined
          );
        }

        if (value && isEnvironmentValue(value)) {
          addEnvironmentEntry(
            environments,
            value,
            sourceLabel,
            createSourceRef(relativePath, line)
          );
        }
      });
    } catch {
      addMissingSourceWarning(relativePath);
    }
  }

  for (const relativePath of [SOURCE_PATHS.smEnvsClient, SOURCE_PATHS.featureFlagEnvs]) {
    try {
      const lines = await readFileLines(resolveSourcePath(automationRepoPath, relativePath));
      collectSpecialCaseEntries(lines).forEach(({ line, value }) => {
        addEnvironmentEntry(
          environments,
          value,
          "helper",
          createSourceRef(relativePath, line)
        );
      });
    } catch {
      addMissingSourceWarning(relativePath);
    }
  }

  try {
    const ciRoot = resolveSourcePath(
      automationRepoPath,
      SOURCE_PATHS.continuousIntegrationRoot
    );
    const groovyFiles = await walkDirectory(ciRoot);
    for (const groovyFile of groovyFiles) {
      const lines = await readFileLines(groovyFile);
      const relativeFile = path.relative(automationRepoPath, groovyFile);
      collectCiChoiceEntries(lines).forEach(({ line, value }) => {
        addEnvironmentEntry(
          environments,
          value,
          "ci",
          createSourceRef(relativeFile, line)
        );
      });
    }
  } catch {
    addMissingSourceWarning(SOURCE_PATHS.continuousIntegrationRoot);
  }

  for (const variants of EXPLICIT_VARIANT_GROUPS) {
    const existingVariants = variants.filter((variant) => environments.has(variant));
    if (existingVariants.length <= 1) {
      continue;
    }

    warnings.add(
      `Environment variants are defined in multiple forms: ${existingVariants.join(", ")}`
    );

    for (const value of existingVariants) {
      const environment = environments.get(value);
      if (!environment) {
        continue;
      }

      const siblingVariants = existingVariants.filter((variant) => variant !== value);
      siblingVariants.forEach((variant) => {
        environment.warnings.add(`Variant also defined as ${variant}.`);
      });
    }
  }

  const ciOnlyEnvironments = [...environments.entries()]
    .filter(([value, environment]) => determineCategory(value, environment) === "ci-only")
    .map(([value]) => value)
    .sort();

  if (ciOnlyEnvironments.length > 0) {
    warnings.add(
      `CI-only environments were discovered outside the typed enum: ${ciOnlyEnvironments.join(", ")}`
    );
  }

  const catalog = [...environments.entries()]
    .map(([value, environment]) => ({
      value,
      category: determineCategory(value, environment),
      normalizedValue: environment.normalizedValue,
      sources: [...environment.sources].sort(),
      warnings: [...environment.warnings].sort()
    }))
    .sort((left, right) => left.value.localeCompare(right.value));

  const supportedCatalog = buildSupportedCatalog(catalog);

  return {
    environments: supportedCatalog,
    warnings: [...warnings].sort()
  };
};
