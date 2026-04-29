import path from "node:path";

export type MissingModuleDiagnostic = {
  moduleName: string;
  requireStack: string[];
};

const isBareModuleSpecifier = (moduleName: string) =>
  !moduleName.startsWith(".") && !path.isAbsolute(moduleName);

const extractRequireStack = (output: string) => {
  const marker = "Require stack:";
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) {
    return [];
  }

  return output
    .slice(markerIndex + marker.length)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .slice(0, 5);
};

export const extractMissingBareModule = (output: string): MissingModuleDiagnostic | undefined => {
  const match = output.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (!match) {
    return undefined;
  }

  const moduleName = match[1];
  if (!isBareModuleSpecifier(moduleName)) {
    return undefined;
  }

  return {
    moduleName,
    requireStack: extractRequireStack(output)
  };
};

export const formatMissingModuleDetails = ({
  diagnostic,
  repoPath,
  installCommand,
  installWasRetried,
  installErrorDetails = []
}: {
  diagnostic: MissingModuleDiagnostic;
  repoPath: string;
  installCommand: string;
  installWasRetried: boolean;
  installErrorDetails?: string[];
}) => {
  const details = [
    `Missing module: ${diagnostic.moduleName}`,
    installWasRetried
      ? `Tried automatic restore: ${installCommand} in ${repoPath}`
      : `Try: cd ${repoPath} && ${installCommand}`,
    `If this persists, declare ${diagnostic.moduleName} in the package.json for the workspace package that imports it, then commit package.json and pnpm-lock.yaml.`
  ];

  if (diagnostic.requireStack.length > 0) {
    details.push(`First importer in require stack: ${diagnostic.requireStack[0]}`);
  }

  return [...details, ...installErrorDetails];
};
