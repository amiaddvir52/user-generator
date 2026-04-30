import { promises as fs } from "node:fs";
import { Node, Project, SyntaxKind, type CallExpression, type Expression, type Statement } from "ts-morph";

import { TugError } from "../common/errors.js";
import type {
  CompatibilityStatus,
  ExecutionMode,
  RemovedCallsite,
  SpecIndexEntry,
  TeardownDetectionResult,
  TransformResult
} from "../common/types.js";
import { computeTransformConfidence } from "./confidence.js";
import { credentialProbeStatements, entryCredentialProbeStatements } from "./credential-probe.js";
import { removeUnusedImportedSpecifiers, rewriteRelativeImportsToAbsolute } from "./import-rewriter.js";

const AFTER_HOOK_PATTERN = /(^|\.)(afterEach|afterAll|beforeAll)$/;
const BEFORE_EACH_PATTERN = /(^|\.)beforeEach$/;
const TEST_PATTERN = /(^|\.)test(?:\.(only|skip|fixme|fail))?$/;
const ASSERTION_SUPPRESSED_COMMENT = "/* tug: assertion suppressed */";

const getCalleeIdentifierFromCall = (callExpression: CallExpression) => {
  const expression = callExpression.getExpression();
  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getName();
  }

  return undefined;
};

const getDirectStatementCallIdentifier = (statement: Statement) => {
  if (!Node.isExpressionStatement(statement)) {
    return undefined;
  }

  const expression = statement.getExpression();
  if (Node.isCallExpression(expression)) {
    return getCalleeIdentifierFromCall(expression);
  }

  if (Node.isAwaitExpression(expression)) {
    const awaitedExpression = expression.getExpression();
    if (Node.isCallExpression(awaitedExpression)) {
      return getCalleeIdentifierFromCall(awaitedExpression);
    }
  }

  return undefined;
};

const isSupportedTestCall = (callExpression: CallExpression, testTitle: string) => {
  const expressionText = callExpression.getExpression().getText();
  if (!TEST_PATTERN.test(expressionText)) {
    return false;
  }

  const firstArgument = callExpression.getArguments()[0];
  if (!firstArgument || (!Node.isStringLiteral(firstArgument) && !Node.isNoSubstitutionTemplateLiteral(firstArgument))) {
    return false;
  }

  return firstArgument.getLiteralText() === testTitle;
};

const getFunctionBodyBlock = (callExpression: CallExpression) => {
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

  return {
    callback,
    body
  };
};

const unwrapExpression = (expression: Expression): Expression => {
  if (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isTypeAssertion(expression) ||
    Node.isNonNullExpression(expression) ||
    Node.isSatisfiesExpression(expression)
  ) {
    return unwrapExpression(expression.getExpression());
  }

  return expression;
};

const unwrapAwaitedAssertionExpression = (expression: Expression): Expression => {
  const unwrapped = unwrapExpression(expression);
  if (Node.isAwaitExpression(unwrapped)) {
    return unwrapExpression(unwrapped.getExpression());
  }

  return unwrapped;
};

const isExpectRootExpression = (expression: Expression): boolean => {
  const unwrapped = unwrapExpression(expression);
  if (Node.isIdentifier(unwrapped)) {
    return unwrapped.getText() === "expect";
  }

  if (Node.isPropertyAccessExpression(unwrapped) || Node.isElementAccessExpression(unwrapped)) {
    return isExpectRootExpression(unwrapped.getExpression());
  }

  return false;
};

const expressionChainContainsExpectCall = (expression: Expression): boolean => {
  const unwrapped = unwrapExpression(expression);
  if (Node.isCallExpression(unwrapped)) {
    return (
      isExpectRootExpression(unwrapped.getExpression()) ||
      expressionChainContainsExpectCall(unwrapped.getExpression())
    );
  }

  if (Node.isPropertyAccessExpression(unwrapped) || Node.isElementAccessExpression(unwrapped)) {
    return expressionChainContainsExpectCall(unwrapped.getExpression());
  }

  return false;
};

const isExpectAssertionExpression = (expression: Expression) =>
  expressionChainContainsExpectCall(unwrapAwaitedAssertionExpression(expression));

const isAssignmentOperator = (kind: SyntaxKind) =>
  kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;

const containsPreservableSideEffect = (node: Node): boolean => {
  if (
    Node.isCallExpression(node) ||
    Node.isAwaitExpression(node) ||
    Node.isDeleteExpression(node) ||
    Node.isNewExpression(node) ||
    Node.isPostfixUnaryExpression(node)
  ) {
    return true;
  }

  if (Node.isPrefixUnaryExpression(node)) {
    const operator = node.getOperatorToken();
    return (
      operator === SyntaxKind.PlusPlusToken ||
      operator === SyntaxKind.MinusMinusToken
    );
  }

  if (Node.isBinaryExpression(node) && isAssignmentOperator(node.getOperatorToken().getKind())) {
    return true;
  }

  return node.getChildren().some((child) => containsPreservableSideEffect(child));
};

const getPreservableArgumentExpression = (argument: Node): Expression | undefined => {
  if (Node.isSpreadElement(argument)) {
    return argument.getExpression();
  }

  return Node.isExpression(argument) ? argument : undefined;
};

const collectPreservedAssertionExpressions = (expression: Expression, preserved: string[]) => {
  const unwrapped = unwrapAwaitedAssertionExpression(expression);
  if (Node.isCallExpression(unwrapped)) {
    collectPreservedAssertionExpressions(unwrapped.getExpression(), preserved);
    unwrapped.getArguments().forEach((argument) => {
      const argumentExpression = getPreservableArgumentExpression(argument);
      if (argumentExpression && containsPreservableSideEffect(argumentExpression)) {
        preserved.push(argumentExpression.getText());
      }
    });
    return;
  }

  if (Node.isPropertyAccessExpression(unwrapped) || Node.isElementAccessExpression(unwrapped)) {
    collectPreservedAssertionExpressions(unwrapped.getExpression(), preserved);
  }
};

const buildSuppressedAssertionStatement = (preservedExpressions: string[]) => {
  if (preservedExpressions.length === 0) {
    return `${ASSERTION_SUPPRESSED_COMMENT} void 0;`;
  }

  return `${ASSERTION_SUPPRESSED_COMMENT} void (${preservedExpressions
    .map((expression) => `(${expression})`)
    .join(", ")});`;
};

const suppressAssertionStatements = (block: import("ts-morph").Block) => {
  block.getDescendantsOfKind(SyntaxKind.ExpressionStatement).forEach((statement) => {
    const expression = statement.getExpression();
    if (!isExpectAssertionExpression(expression)) {
      return;
    }

    const preservedExpressions: string[] = [];
    collectPreservedAssertionExpressions(expression, preservedExpressions);
    statement.replaceWithText(buildSuppressedAssertionStatement(preservedExpressions));
  });
};

const removeDirectTeardownStatements = ({
  block,
  confirmed,
  suspected,
  teardownScoreMap,
  kind,
  removedCalls,
  uncertainIdentifiers
}: {
  block: import("ts-morph").Block;
  confirmed: Set<string>;
  suspected: Set<string>;
  teardownScoreMap: Map<string, number>;
  kind: "hook" | "body";
  removedCalls: RemovedCallsite[];
  uncertainIdentifiers: Set<string>;
}) => {
  block.getStatements().forEach((statement) => {
    const identifier = getDirectStatementCallIdentifier(statement);
    if (!identifier) {
      return;
    }

    if (confirmed.has(identifier)) {
      removedCalls.push({
        identifier,
        line: statement.getStartLineNumber(),
        kind,
        score: teardownScoreMap.get(identifier) ?? 0
      });
      statement.remove();
      return;
    }

    if (suspected.has(identifier)) {
      uncertainIdentifiers.add(identifier);
    }
  });
};

export const transformSelectedSpec = async ({
  entry,
  teardown,
  compatibilityStatus,
  workingTreeDirty,
  knownFingerprint,
  executionMode = "full"
}: {
  entry: SpecIndexEntry;
  teardown: TeardownDetectionResult;
  compatibilityStatus: CompatibilityStatus;
  workingTreeDirty: boolean;
  knownFingerprint: boolean;
  executionMode?: ExecutionMode;
}): Promise<TransformResult> => {
  const originalText = await fs.readFile(entry.filePath, "utf8");

  const project = new Project({
    skipAddingFilesFromTsConfig: true
  });
  const sourceFile = project.createSourceFile(entry.filePath, originalText, { overwrite: true });

  const confirmedSet = new Set(teardown.confirmed);
  const suspectedSet = new Set(teardown.suspected);
  const teardownScoreMap = new Map(teardown.scores.map((score) => [score.identifier, score.score]));

  const removedCalls: RemovedCallsite[] = [];
  const unknownHookCalls = new Set<string>();
  const uncertainIdentifiers = new Set<string>();

  sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpression) => {
    const expressionText = callExpression.getExpression().getText();
    if (!AFTER_HOOK_PATTERN.test(expressionText)) {
      return;
    }

    const callbackData = getFunctionBodyBlock(callExpression);
    if (!callbackData) {
      return;
    }

    const statements = callbackData.body.getStatements();
    if (statements.length === 0) {
      return;
    }

    const identifiers = statements.map((statement) => getDirectStatementCallIdentifier(statement)).filter(Boolean) as string[];
    if (identifiers.length !== statements.length) {
      return;
    }

    const hasUnknown = identifiers.some(
      (identifier) => !confirmedSet.has(identifier) && !suspectedSet.has(identifier)
    );
    if (hasUnknown) {
      identifiers
        .filter((identifier) => !confirmedSet.has(identifier) && !suspectedSet.has(identifier))
        .forEach((identifier) => unknownHookCalls.add(identifier));
      return;
    }

    const hasSuspected = identifiers.some((identifier) => suspectedSet.has(identifier));
    if (hasSuspected) {
      identifiers
        .filter((identifier) => suspectedSet.has(identifier))
        .forEach((identifier) => uncertainIdentifiers.add(identifier));
      return;
    }

    statements.forEach((statement) => {
      const identifier = getDirectStatementCallIdentifier(statement);
      if (!identifier) {
        return;
      }

      removedCalls.push({
        identifier,
        line: statement.getStartLineNumber(),
        kind: "hook",
        score: teardownScoreMap.get(identifier) ?? 0
      });
    });

    callbackData.callback.setBodyText((writer) => {
      writer.writeLine("/* tug: teardown suppressed */");
    });
  });

  const selectedTestCall = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((callExpression) => isSupportedTestCall(callExpression, entry.testTitle));

  if (!selectedTestCall) {
    throw new TugError(
      "TRANSFORM_INCOMPLETE",
      `Selected test title was not found for transform: ${entry.testTitle}`
    );
  }

  const selectedTestBody = getFunctionBodyBlock(selectedTestCall)?.body;
  if (!selectedTestBody) {
    throw new TugError(
      "TRANSFORM_INCOMPLETE",
      `Selected test body is not a supported block function: ${entry.testTitle}`
    );
  }

  removeDirectTeardownStatements({
    block: selectedTestBody,
    confirmed: confirmedSet,
    suspected: suspectedSet,
    teardownScoreMap,
    kind: "body",
    removedCalls,
    uncertainIdentifiers
  });

  sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpression) => {
    const expressionText = callExpression.getExpression().getText();
    if (!BEFORE_EACH_PATTERN.test(expressionText)) {
      return;
    }

    const hookBody = getFunctionBodyBlock(callExpression)?.body;
    if (!hookBody) {
      return;
    }

    removeDirectTeardownStatements({
      block: hookBody,
      confirmed: confirmedSet,
      suspected: suspectedSet,
      teardownScoreMap,
      kind: "body",
      removedCalls,
      uncertainIdentifiers
    });
  });

  if (unknownHookCalls.size > 0) {
    throw new TugError(
      "TEARDOWN_HOOK_HAS_UNKNOWN_CALL",
      "Teardown hook contains call(s) that were not classified as teardown.",
      [...unknownHookCalls].sort()
    );
  }

  if (executionMode === "fast") {
    suppressAssertionStatements(selectedTestBody);
  }

  selectedTestBody.insertStatements(0, entryCredentialProbeStatements().join("\n"));
  selectedTestBody.addStatements(credentialProbeStatements().join("\n"));

  rewriteRelativeImportsToAbsolute({
    sourceFile,
    sourceAbsolutePath: entry.filePath
  });
  removeUnusedImportedSpecifiers(sourceFile);

  const transformedText = sourceFile.getFullText();

  const { confidence } = computeTransformConfidence({
    removedCalls,
    compatibilityStatus: knownFingerprint ? "supported" : compatibilityStatus,
    singleTestMatch: true,
    workingTreeDirty
  });

  return {
    transformedText,
    originalText,
    selectedTitle: entry.testTitle,
    sourceFile: entry.filePath,
    removedCalls: removedCalls.sort((left, right) => left.line - right.line),
    confidence,
    unknownHookCalls: [],
    uncertainIdentifiers: [...uncertainIdentifiers].sort()
  };
};
