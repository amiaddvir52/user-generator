import path from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type Identifier,
  type SourceFile
} from "ts-morph";

import type {
  CompatibilityStatus,
  TeardownDetectionResult,
  TeardownScore
} from "../common/types.js";

const HOOK_NAME_PATTERN = /(^|\.)(afterEach|afterAll|beforeAll)$/;
const TEARDOWN_NAME_PATTERN = /(delete|teardown|dispose|destroy|deregister|cleanup|remove)/i;

const getCalleeIdentifier = (callExpression: CallExpression) => {
  const expression = callExpression.getExpression();
  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getName();
  }

  return undefined;
};

const isHookRegistrationCall = (callExpression: CallExpression) => {
  const expressionText = callExpression.getExpression().getText();
  return HOOK_NAME_PATTERN.test(expressionText);
};

const getHookBodies = (sourceFile: SourceFile) => {
  const bodies: Node[] = [];
  sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpression) => {
    if (!isHookRegistrationCall(callExpression)) {
      return;
    }

    const callback = callExpression
      .getArguments()
      .find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
    if (!callback || !Node.isFunctionLikeDeclaration(callback)) {
      return;
    }

    const body = callback.getBody();
    if (!body) {
      return;
    }

    bodies.push(body);
  });

  return bodies;
};

const getImportedModuleForIdentifier = (identifier: Identifier) => {
  const importSpecifier = identifier.getDefinitions().find((definition) => {
    const declarationNode = definition.getDeclarationNode();
    return declarationNode && Node.isImportSpecifier(declarationNode);
  });

  if (!importSpecifier) {
    return undefined;
  }

  const declarationNode = importSpecifier.getDeclarationNode();
  if (!declarationNode || !Node.isImportSpecifier(declarationNode)) {
    return undefined;
  }

  return declarationNode.getImportDeclaration().getModuleSpecifierValue();
};

const collectFunctionCallGraph = (project: Project) => {
  const graph = new Map<string, Set<string>>();

  project.getSourceFiles().forEach((sourceFile) => {
    sourceFile.getFunctions().forEach((fn) => {
      const name = fn.getName();
      const body = fn.getBody();
      if (!name || !body) {
        return;
      }

      const called = new Set<string>();
      body.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpression) => {
        const identifier = getCalleeIdentifier(callExpression);
        if (identifier) {
          called.add(identifier);
        }
      });

      graph.set(name, called);
    });
  });

  return graph;
};

export const discoverTeardownIdentifiers = ({
  project,
  compatibilityStatus,
  teardownHints
}: {
  project: Project;
  compatibilityStatus: CompatibilityStatus;
  teardownHints: string[];
}): TeardownDetectionResult => {
  const hookCounts = new Map<string, number>();
  const totalCounts = new Map<string, number>();
  const importedFromModule = new Map<string, Set<string>>();
  const hookCalls = new Set<string>();

  project.getSourceFiles().forEach((sourceFile) => {
    const hookBodies = getHookBodies(sourceFile);
    hookBodies.forEach((body) => {
      body.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpression) => {
        const identifier = getCalleeIdentifier(callExpression);
        if (!identifier) {
          return;
        }

        hookCalls.add(identifier);
        hookCounts.set(identifier, (hookCounts.get(identifier) ?? 0) + 1);
      });
    });

    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpression) => {
      if (isHookRegistrationCall(callExpression)) {
        return;
      }

      const identifier = getCalleeIdentifier(callExpression);
      if (!identifier) {
        return;
      }

      totalCounts.set(identifier, (totalCounts.get(identifier) ?? 0) + 1);

      const expression = callExpression.getExpression();
      if (!Node.isIdentifier(expression)) {
        return;
      }

      const moduleName = getImportedModuleForIdentifier(expression);
      if (!moduleName) {
        return;
      }

      const moduleSet = importedFromModule.get(identifier) ?? new Set<string>();
      moduleSet.add(moduleName);
      importedFromModule.set(identifier, moduleSet);
    });
  });

  const functionCallGraph = collectFunctionCallGraph(project);

  const seededTeardown = new Set<string>(teardownHints);
  [...totalCounts.keys()].forEach((identifier) => {
    const hookCount = hookCounts.get(identifier) ?? 0;
    const totalCount = totalCounts.get(identifier) ?? 0;
    const pHook = totalCount > 0 ? hookCount / totalCount : 0;
    const pName = TEARDOWN_NAME_PATTERN.test(identifier) ? 1 : 0;

    if (pHook >= 0.5 || pName === 1) {
      seededTeardown.add(identifier);
    }
  });

  const scores: TeardownScore[] = [...totalCounts.keys()].map((identifier) => {
    const hookCount = hookCounts.get(identifier) ?? 0;
    const totalCount = totalCounts.get(identifier) ?? 0;
    const pHook = totalCount > 0 ? hookCount / totalCount : 0;
    const pName = TEARDOWN_NAME_PATTERN.test(identifier) ? 1 : 0;

    const calledIdentifiers = functionCallGraph.get(identifier) ?? new Set<string>();
    const pTrans = [...calledIdentifiers].some((callee) => seededTeardown.has(callee)) ? 1 : 0;

    const modules = importedFromModule.get(identifier) ?? new Set<string>();
    const pOrigin = [...modules].some((moduleName) => {
      const basename = path.basename(moduleName).toLowerCase();
      return TEARDOWN_NAME_PATTERN.test(basename);
    })
      ? 1
      : 0;

    const score = Number((pHook * 0.45 + pName * 0.2 + pTrans * 0.25 + pOrigin * 0.1).toFixed(4));

    return {
      identifier,
      score,
      pHook: Number(pHook.toFixed(4)),
      pName,
      pTrans,
      pOrigin
    };
  });

  const confirmedThreshold = compatibilityStatus === "supported" ? 0.75 : 0.85;
  const suspectedThreshold = 0.5;

  const confirmed = scores
    .filter((score) => score.score >= confirmedThreshold)
    .map((score) => score.identifier)
    .sort();

  const suspected = scores
    .filter((score) => score.score >= suspectedThreshold && score.score < confirmedThreshold)
    .map((score) => score.identifier)
    .sort();

  return {
    confirmed,
    suspected,
    scores: scores.sort((left, right) => right.score - left.score),
    observedHookCalls: [...hookCalls].sort()
  };
};

