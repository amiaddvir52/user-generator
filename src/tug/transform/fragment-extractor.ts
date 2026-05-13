import { promises as fs } from "node:fs";
import { Node, Project, SyntaxKind, type Block, type CallExpression, type Statement } from "ts-morph";

import type { SpecIndexEntry, TeardownDetectionResult } from "../common/types.js";

const TEST_PATTERN = /(^|\.)test(?:\.(only|skip|fixme|fail))?$/;

export type FragmentKind = "setup" | "action" | "assertion" | "teardown";

export type Fragment = {
  sourceFile: string;
  kind: FragmentKind;
  text: string;
  identifier?: string;
  referencedIdentifiers: string[];
};

const getCalleeIdentifier = (callExpression: CallExpression): string | undefined => {
  const expression = callExpression.getExpression();
  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }
  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getName();
  }
  return undefined;
};

const getStatementCallIdentifier = (statement: Statement): string | undefined => {
  if (!Node.isExpressionStatement(statement)) {
    return undefined;
  }
  let expression = statement.getExpression();
  if (Node.isAwaitExpression(expression)) {
    expression = expression.getExpression();
  }
  if (Node.isCallExpression(expression)) {
    return getCalleeIdentifier(expression);
  }
  return undefined;
};

const containsExpect = (statement: Statement): boolean => {
  return statement
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((callExpression) => {
      const expression = callExpression.getExpression();
      if (Node.isIdentifier(expression) && expression.getText() === "expect") {
        return true;
      }
      if (Node.isPropertyAccessExpression(expression)) {
        const root = expression.getExpression();
        if (Node.isIdentifier(root) && root.getText() === "expect") {
          return true;
        }
        if (Node.isCallExpression(root)) {
          const rootCallee = root.getExpression();
          if (Node.isIdentifier(rootCallee) && rootCallee.getText() === "expect") {
            return true;
          }
        }
      }
      return false;
    });
};

const collectLocallyDeclaredNames = (statement: Statement): Set<string> => {
  const names = new Set<string>();
  statement.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((declaration) => {
    const nameNode = declaration.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      names.add(nameNode.getText());
    } else {
      nameNode.getDescendantsOfKind(SyntaxKind.Identifier).forEach((identifier) => {
        names.add(identifier.getText());
      });
    }
  });
  statement.getDescendantsOfKind(SyntaxKind.Parameter).forEach((parameter) => {
    const nameNode = parameter.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      names.add(nameNode.getText());
    } else {
      nameNode.getDescendantsOfKind(SyntaxKind.Identifier).forEach((identifier) => {
        names.add(identifier.getText());
      });
    }
  });
  return names;
};

const collectReferencedIdentifiers = (statement: Statement): string[] => {
  const identifiers = new Set<string>();
  const locallyDeclared = collectLocallyDeclaredNames(statement);
  statement.getDescendantsOfKind(SyntaxKind.Identifier).forEach((identifier) => {
    const parent = identifier.getParent();
    if (parent && (Node.isPropertyAccessExpression(parent) || Node.isQualifiedName(parent))) {
      if (parent.getChildAtIndex(0) !== identifier) {
        return;
      }
    }
    if (parent && Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) {
      return;
    }
    const name = identifier.getText();
    if (locallyDeclared.has(name)) {
      return;
    }
    identifiers.add(name);
  });
  return [...identifiers].sort();
};

const findTestCall = (sourceFile: import("ts-morph").SourceFile, testTitle: string): CallExpression | undefined => {
  return sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).find((callExpression) => {
    const expressionText = callExpression.getExpression().getText();
    if (!TEST_PATTERN.test(expressionText)) {
      return false;
    }
    const firstArgument = callExpression.getArguments()[0];
    if (!firstArgument || (!Node.isStringLiteral(firstArgument) && !Node.isNoSubstitutionTemplateLiteral(firstArgument))) {
      return false;
    }
    return firstArgument.getLiteralText() === testTitle;
  });
};

const getTestBody = (callExpression: CallExpression): Block | undefined => {
  const callback = callExpression
    .getArguments()
    .find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
  if (!callback || !Node.isFunctionLikeDeclaration(callback)) {
    return undefined;
  }
  const body = callback.getBody();
  if (!body || !Node.isBlock(body)) {
    return undefined;
  }
  return body;
};

const classifyStatement = ({
  statement,
  seenExpect,
  confirmed,
  suspected
}: {
  statement: Statement;
  seenExpect: boolean;
  confirmed: Set<string>;
  suspected: Set<string>;
}): { kind: FragmentKind; flipSeenExpect: boolean } => {
  if (containsExpect(statement)) {
    return { kind: "assertion", flipSeenExpect: true };
  }

  const identifier = getStatementCallIdentifier(statement);
  if (identifier && (confirmed.has(identifier) || suspected.has(identifier))) {
    return { kind: "teardown", flipSeenExpect: seenExpect };
  }

  if (seenExpect) {
    return { kind: "teardown", flipSeenExpect: seenExpect };
  }

  return { kind: identifier ? "action" : "setup", flipSeenExpect: seenExpect };
};

export const extractFragments = async ({
  entry,
  teardown
}: {
  entry: SpecIndexEntry;
  teardown: TeardownDetectionResult;
}): Promise<Fragment[]> => {
  const originalText = await fs.readFile(entry.filePath, "utf8");
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.createSourceFile(entry.filePath, originalText, { overwrite: true });

  const testCall = findTestCall(sourceFile, entry.testTitle);
  if (!testCall) {
    return [];
  }
  const body = getTestBody(testCall);
  if (!body) {
    return [];
  }

  const confirmed = new Set(teardown.confirmed);
  const suspected = new Set(teardown.suspected);
  const fragments: Fragment[] = [];
  let seenExpect = false;
  let leadingSetupDone = false;

  for (const statement of body.getStatements()) {
    const { kind } = classifyStatement({ statement, seenExpect, confirmed, suspected });
    if (kind === "assertion") {
      seenExpect = true;
    }

    let resolvedKind = kind;
    if (!leadingSetupDone && kind === "action") {
      const identifier = getStatementCallIdentifier(statement);
      if (identifier && entry.helperImports.length > 0 && /helper|login|navigate|setup|init/i.test(identifier)) {
        resolvedKind = "setup";
      }
    }
    if (resolvedKind === "action") {
      leadingSetupDone = true;
    }

    fragments.push({
      sourceFile: entry.filePath,
      kind: resolvedKind,
      text: statement.getText(),
      identifier: getStatementCallIdentifier(statement),
      referencedIdentifiers: collectReferencedIdentifiers(statement)
    });
  }

  return fragments;
};

export const collectImportedIdentifiers = async (filePath: string): Promise<Set<string>> => {
  const text = await fs.readFile(filePath, "utf8");
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.createSourceFile(filePath, text, { overwrite: true });
  const identifiers = new Set<string>();
  sourceFile.getImportDeclarations().forEach((declaration) => {
    declaration.getNamedImports().forEach((named) => identifiers.add(named.getName()));
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) {
      identifiers.add(defaultImport.getText());
    }
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport) {
      identifiers.add(namespaceImport.getText());
    }
  });
  return identifiers;
};
