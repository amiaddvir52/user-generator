import { promises as fs } from "node:fs";
import { Node, Project, SyntaxKind, type CallExpression, type Statement } from "ts-morph";

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
import {
  credentialProbeStatements,
  earlyReturnCredentialProbeStatements,
  entryCredentialProbeStatements
} from "./credential-probe.js";
import { removeUnusedImportedSpecifiers, rewriteRelativeImportsToAbsolute } from "./import-rewriter.js";

const AFTER_HOOK_PATTERN = /(^|\.)(afterEach|afterAll|beforeAll)$/;
const BEFORE_EACH_PATTERN = /(^|\.)beforeEach$/;
const TEST_PATTERN = /(^|\.)test(?:\.(only|skip|fixme|fail))?$/;

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

  const preludeStatements = executionMode === "fast"
    ? [...entryCredentialProbeStatements(), ...earlyReturnCredentialProbeStatements()]
    : entryCredentialProbeStatements();
  selectedTestBody.insertStatements(0, preludeStatements.join("\n"));
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
