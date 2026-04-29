import path from "node:path";
import { promises as fs } from "node:fs";
import { Node, Project, SyntaxKind, type SourceFile } from "ts-morph";

import type {
  CompatibilityResult,
  IndexData,
  RepoHandle,
  ScoreHints,
  SpecIndexEntry
} from "../common/types.js";
import { discoverTeardownIdentifiers } from "./teardown-detector.js";

const TEST_TITLE_TAG_PATTERN = /@[a-z0-9_-]+/gi;

const isDescribeExpression = (expressionText: string) =>
  /(^|\.)test\.describe(?:\.[a-z]+)?$/.test(expressionText) || /(^|\.)describe$/.test(expressionText);

const isTestExpression = (expressionText: string) =>
  /(^|\.)test(?:\.(only|skip|fixme|fail))?$/.test(expressionText);

const collectScoreHints = (title: string): ScoreHints => {
  const lower = title.toLowerCase();
  return {
    payerLocation: lower.includes("us")
      ? "us"
      : lower.includes("eu")
        ? "eu"
        : lower.includes("gcp")
          ? "gcp"
          : undefined,
    contractType: lower.includes("on-demand")
      ? "on-demand"
      : lower.includes("annual")
        ? "annual"
        : lower.includes("monthly")
          ? "monthly"
          : undefined
  };
};

const asStringLiteral = (node: Node | undefined) => {
  if (!node) {
    return undefined;
  }

  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }

  return undefined;
};

const collectHelperImports = (sourceFile: SourceFile) =>
  sourceFile
    .getImportDeclarations()
    .map((declaration) => declaration.getModuleSpecifierValue())
    .filter((moduleName) => moduleName.includes("playwright-helpers"))
    .sort();

const collectDirectCallIdentifiers = (node: Node) => {
  const identifiers = new Set<string>();
  node.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpression) => {
    const expression = callExpression.getExpression();
    if (Node.isIdentifier(expression)) {
      identifiers.add(expression.getText());
      return;
    }

    if (Node.isPropertyAccessExpression(expression)) {
      identifiers.add(expression.getName());
    }
  });
  return [...identifiers].sort();
};

const collectEntriesFromNode = ({
  node,
  sourceFile,
  describeStack,
  helperImports,
  out
}: {
  node: Node;
  sourceFile: SourceFile;
  describeStack: string[];
  helperImports: string[];
  out: SpecIndexEntry[];
}) => {
  node.forEachChild((child) => {
    if (!Node.isExpressionStatement(child)) {
      collectEntriesFromNode({
        node: child,
        sourceFile,
        describeStack,
        helperImports,
        out
      });
      return;
    }

    const expression = child.getExpression();
    if (!Node.isCallExpression(expression)) {
      return;
    }

    const expressionText = expression.getExpression().getText();
    const title = asStringLiteral(expression.getArguments()[0]);

    if (isDescribeExpression(expressionText) && title) {
      const callback = expression
        .getArguments()
        .find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
      const callbackBody = callback && Node.isFunctionLikeDeclaration(callback) ? callback.getBody() : undefined;
      if (callbackBody) {
        collectEntriesFromNode({
          node: callbackBody,
          sourceFile,
          describeStack: [...describeStack, title],
          helperImports,
          out
        });
      }
      return;
    }

    if (!isTestExpression(expressionText) || !title) {
      return;
    }

    const callback = expression
      .getArguments()
      .find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
    const callbackBody = callback && Node.isFunctionLikeDeclaration(callback) ? callback.getBody() : undefined;

    out.push({
      filePath: sourceFile.getFilePath(),
      testTitle: title,
      describeTitles: describeStack,
      tags: [...new Set(title.match(TEST_TITLE_TAG_PATTERN) ?? [])].map((tag) => tag.toLowerCase()).sort(),
      helperImports,
      teardownCalls: callbackBody ? collectDirectCallIdentifiers(callbackBody) : [],
      scoreHints: collectScoreHints(`${describeStack.join(" ")} ${title}`)
    });
  });
};

const walkForSpecs = async (rootPath: string): Promise<string[]> => {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      files.push(...(await walkForSpecs(entryPath)));
      continue;
    }

    if (entry.isFile() && /\.(spec|test)\.ts$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
};

export const createProjectForSpecs = async (repo: RepoHandle) => {
  const specFiles = await walkForSpecs(repo.smRootPath);
  const project = new Project({
    tsConfigFilePath: repo.tsconfigPath,
    skipFileDependencyResolution: true
  });

  project.addSourceFilesAtPaths(specFiles);

  return project;
};

export const buildSpecIndex = async ({
  repo,
  fingerprint,
  compatibility
}: {
  repo: RepoHandle;
  fingerprint: string;
  compatibility: CompatibilityResult;
}): Promise<IndexData> => {
  const project = await createProjectForSpecs(repo);

  const entries: SpecIndexEntry[] = [];
  project.getSourceFiles().forEach((sourceFile) => {
    const helperImports = collectHelperImports(sourceFile);
    collectEntriesFromNode({
      node: sourceFile,
      sourceFile,
      describeStack: [],
      helperImports,
      out: entries
    });
  });

  const teardown = discoverTeardownIdentifiers({
    project,
    compatibilityStatus: compatibility.status,
    teardownHints: compatibility.knownTeardownHints
  });

  return {
    fingerprint,
    generatedAt: new Date().toISOString(),
    entries: entries.sort((left, right) => {
      if (left.filePath === right.filePath) {
        return left.testTitle.localeCompare(right.testTitle);
      }
      return left.filePath.localeCompare(right.filePath);
    }),
    teardown
  };
};

