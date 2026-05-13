import { promises as fs } from "node:fs";
import { Node, Project, SourceFile, SyntaxKind, type CallExpression, type Statement } from "ts-morph";

import type { SpecIndexEntry, TeardownDetectionResult } from "../common/types.js";
import { findTestCall, getTestBody } from "./test-call.js";

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

const collectIdentifiersImportedFromHelperModules = (
  sourceFile: SourceFile,
  helperImports: string[]
): Set<string> => {
  const helperSet = new Set(helperImports);
  const names = new Set<string>();
  sourceFile.getImportDeclarations().forEach((declaration) => {
    const moduleSpecifier = declaration.getModuleSpecifierValue();
    if (!helperSet.has(moduleSpecifier)) {
      return;
    }
    declaration.getNamedImports().forEach((named) => names.add(named.getName()));
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) {
      names.add(defaultImport.getText());
    }
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport) {
      names.add(namespaceImport.getText());
    }
  });
  return names;
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
  const helperImportNames = collectIdentifiersImportedFromHelperModules(sourceFile, entry.helperImports);
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
      // Only demote leading "actions" whose callee actually comes from a helper module.
      // The previous regex (/helper|login|navigate|setup|init/i) demoted real actions
      // like loginUser() and dropped them from splicing.
      if (identifier && helperImportNames.has(identifier)) {
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
