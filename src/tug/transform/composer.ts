import path from "node:path";
import { promises as fs } from "node:fs";
import { Node, Project, SyntaxKind, type Block, type CallExpression, type SourceFile } from "ts-morph";

import { TugError } from "../common/errors.js";
import type {
  CompatibilityStatus,
  CompositionInfo,
  ExecutionMode,
  Intent,
  RankedCandidate,
  SpecIndexEntry,
  TeardownDetectionResult,
  TransformResult
} from "../common/types.js";
import { extractFragments, type Fragment } from "./fragment-extractor.js";
import { applyBaseTransformMutations } from "./transformer.js";

const TEST_PATTERN = /(^|\.)test(?:\.(only|skip|fixme|fail))?$/;
const COMPOSED_FRAGMENT_BANNER = "/* tug: composed fragment from {{donor}} */";

const findTestCall = (sourceFile: SourceFile, testTitle: string): CallExpression | undefined => {
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

const collectImportedNames = (sourceFile: SourceFile): Set<string> => {
  const names = new Set<string>();
  sourceFile.getImportDeclarations().forEach((declaration) => {
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

const collectTopLevelDeclaredNames = (sourceFile: SourceFile): Set<string> => {
  const names = new Set<string>();
  sourceFile.getVariableDeclarations().forEach((declaration) => {
    if (declaration.getVariableStatement()?.getParent()?.getKind() === SyntaxKind.SourceFile) {
      names.add(declaration.getName());
    }
  });
  sourceFile.getFunctions().forEach((fn) => {
    const name = fn.getName();
    if (name) {
      names.add(name);
    }
  });
  return names;
};

const fragmentAddsSignal = (fragment: Fragment, intent: Intent, baseText: string): boolean => {
  const fragmentLower = fragment.text.toLowerCase();
  const keywordSignal = intent.keywords.some(
    (keyword) => fragmentLower.includes(keyword.toLowerCase()) && !baseText.toLowerCase().includes(keyword.toLowerCase())
  );
  if (keywordSignal) {
    return true;
  }
  const hintSignal = [intent.hints.payerLocation, intent.hints.contractType]
    .filter((value): value is string => Boolean(value))
    .some((value) => fragmentLower.includes(value.toLowerCase()) && !baseText.toLowerCase().includes(value.toLowerCase()));
  return hintSignal;
};

const isPlaywrightBuiltin = (identifier: string): boolean => {
  return (
    identifier === "expect" ||
    identifier === "test" ||
    identifier === "page" ||
    identifier === "context" ||
    identifier === "browser" ||
    identifier === "request" ||
    identifier === "console" ||
    identifier === "process"
  );
};

const isLanguagePrimitive = (identifier: string): boolean => {
  return /^(?:await|async|true|false|null|undefined|new|return|if|else|for|while|let|const|var)$/.test(identifier);
};

const rewriteRelativeSpecifier = ({
  moduleSpecifier,
  donorFilePath,
  baseFilePath
}: {
  moduleSpecifier: string;
  donorFilePath: string;
  baseFilePath: string;
}): string => {
  if (!moduleSpecifier.startsWith(".")) {
    return moduleSpecifier;
  }
  const donorDirectory = path.dirname(donorFilePath);
  const baseDirectory = path.dirname(baseFilePath);
  const absoluteTarget = path.resolve(donorDirectory, moduleSpecifier);
  let relative = path.relative(baseDirectory, absoluteTarget).replace(/\\/g, "/");
  if (relative === "") {
    relative = ".";
  }
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
};

const collectDonorImportDeclarations = (
  donorSourceFile: SourceFile,
  donorFilePath: string,
  baseFilePath: string
) => {
  return donorSourceFile.getImportDeclarations().map((declaration) => {
    const moduleSpecifier = declaration.getModuleSpecifierValue();
    return {
      moduleSpecifier: rewriteRelativeSpecifier({ moduleSpecifier, donorFilePath, baseFilePath }),
      namedImports: declaration.getNamedImports().map((named) => named.getName()),
      defaultImport: declaration.getDefaultImport()?.getText(),
      namespaceImport: declaration.getNamespaceImport()?.getText()
    };
  });
};

const mergeImports = ({
  baseSourceFile,
  donorSourceFile,
  donorFilePath,
  baseFilePath
}: {
  baseSourceFile: SourceFile;
  donorSourceFile: SourceFile;
  donorFilePath: string;
  baseFilePath: string;
}): Set<string> => {
  const addedNames = new Set<string>();
  const baseNames = collectImportedNames(baseSourceFile);
  const donorImports = collectDonorImportDeclarations(donorSourceFile, donorFilePath, baseFilePath);

  donorImports.forEach((donorImport) => {
    const namedToAdd = donorImport.namedImports.filter((name) => !baseNames.has(name));
    const needsDefault = donorImport.defaultImport && !baseNames.has(donorImport.defaultImport);
    const needsNamespace = donorImport.namespaceImport && !baseNames.has(donorImport.namespaceImport);

    if (namedToAdd.length === 0 && !needsDefault && !needsNamespace) {
      return;
    }

    const existing = baseSourceFile
      .getImportDeclarations()
      .find((declaration) => declaration.getModuleSpecifierValue() === donorImport.moduleSpecifier);

    if (existing) {
      namedToAdd.forEach((name) => {
        existing.addNamedImport(name);
        baseNames.add(name);
        addedNames.add(name);
      });
      if (needsDefault && donorImport.defaultImport && !existing.getDefaultImport()) {
        existing.setDefaultImport(donorImport.defaultImport);
        baseNames.add(donorImport.defaultImport);
        addedNames.add(donorImport.defaultImport);
      }
      return;
    }

    baseSourceFile.addImportDeclaration({
      moduleSpecifier: donorImport.moduleSpecifier,
      namedImports: namedToAdd.length > 0 ? namedToAdd : undefined,
      defaultImport: needsDefault ? donorImport.defaultImport : undefined,
      namespaceImport: needsNamespace ? donorImport.namespaceImport : undefined
    });
    namedToAdd.forEach((name) => {
      baseNames.add(name);
      addedNames.add(name);
    });
    if (needsDefault && donorImport.defaultImport) {
      baseNames.add(donorImport.defaultImport);
      addedNames.add(donorImport.defaultImport);
    }
    if (needsNamespace && donorImport.namespaceImport) {
      baseNames.add(donorImport.namespaceImport);
      addedNames.add(donorImport.namespaceImport);
    }
  });

  return addedNames;
};

const findSpliceInsertionIndex = (body: Block): number => {
  const statements = body.getStatements();
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i];
    const callExpressions = statement.getDescendantsOfKind(SyntaxKind.CallExpression);
    const hasExpect = callExpressions.some((call) => {
      const expression = call.getExpression();
      if (Node.isIdentifier(expression) && expression.getText() === "expect") {
        return true;
      }
      if (Node.isPropertyAccessExpression(expression)) {
        const root = expression.getExpression();
        return Node.isIdentifier(root) && root.getText() === "expect";
      }
      return false;
    });
    if (hasExpect) {
      return i;
    }
  }
  return statements.length;
};

export const composeSyntheticSpec = async ({
  baseEntry,
  donorCandidates,
  intent,
  teardown,
  compatibilityStatus,
  workingTreeDirty,
  knownFingerprint,
  executionMode = "full"
}: {
  baseEntry: SpecIndexEntry;
  donorCandidates: RankedCandidate[];
  intent: Intent;
  teardown: TeardownDetectionResult;
  compatibilityStatus: CompatibilityStatus;
  workingTreeDirty: boolean;
  knownFingerprint: boolean;
  executionMode?: ExecutionMode;
}): Promise<TransformResult> => {
  const baseText = await fs.readFile(baseEntry.filePath, "utf8");
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const baseSourceFile = project.createSourceFile(baseEntry.filePath, baseText, { overwrite: true });

  const baseTestCall = findTestCall(baseSourceFile, baseEntry.testTitle);
  if (!baseTestCall) {
    throw new TugError(
      "TRANSFORM_INCOMPLETE",
      `Base test title not found for composition: ${baseEntry.testTitle}`
    );
  }
  const baseBody = getTestBody(baseTestCall);
  if (!baseBody) {
    throw new TugError(
      "TRANSFORM_INCOMPLETE",
      `Base test body is not a supported block function: ${baseEntry.testTitle}`
    );
  }

  const acceptedDonors: string[] = [];
  const accumulatedFragmentTexts: string[] = [];
  const baseTextRunning = () => baseText + "\n" + accumulatedFragmentTexts.join("\n");
  let totalFragmentCount = 0;

  const donorOnly = donorCandidates.filter(
    (candidate) =>
      candidate.entry.filePath !== baseEntry.filePath || candidate.entry.testTitle !== baseEntry.testTitle
  );

  for (const donor of donorOnly) {
    const donorEntry = donor.entry;
    const fragments = await extractFragments({ entry: donorEntry, teardown });
    const actionFragments = fragments.filter((fragment) => fragment.kind === "action");
    if (actionFragments.length === 0) {
      continue;
    }

    const signalFragments = actionFragments.filter((fragment) => fragmentAddsSignal(fragment, intent, baseTextRunning()));
    if (signalFragments.length === 0) {
      continue;
    }

    const donorText = await fs.readFile(donorEntry.filePath, "utf8");
    const donorSourceFile = project.createSourceFile(`${donorEntry.filePath}::donor-${acceptedDonors.length}`, donorText, { overwrite: true });

    const importedAfterMerge = new Set([
      ...collectImportedNames(baseSourceFile),
      ...collectTopLevelDeclaredNames(baseSourceFile)
    ]);
    const donorImportsPreview = collectDonorImportDeclarations(donorSourceFile, donorEntry.filePath, baseEntry.filePath);
    donorImportsPreview.forEach((donorImport) => {
      donorImport.namedImports.forEach((name) => importedAfterMerge.add(name));
      if (donorImport.defaultImport) importedAfterMerge.add(donorImport.defaultImport);
      if (donorImport.namespaceImport) importedAfterMerge.add(donorImport.namespaceImport);
    });

    for (const fragment of signalFragments) {
      for (const identifier of fragment.referencedIdentifiers) {
        if (isPlaywrightBuiltin(identifier) || isLanguagePrimitive(identifier)) {
          continue;
        }
        if (importedAfterMerge.has(identifier)) {
          continue;
        }
        throw new TugError(
          "COMPOSITION_FRAGMENT_INCOMPATIBLE",
          `Donor fragment references identifier "${identifier}" not importable from base (donor: ${donorEntry.filePath}).`,
          [identifier, fragment.text.slice(0, 200)]
        );
      }
    }

    mergeImports({
      baseSourceFile,
      donorSourceFile,
      donorFilePath: donorEntry.filePath,
      baseFilePath: baseEntry.filePath
    });

    const insertionIndex = findSpliceInsertionIndex(baseBody);
    const banner = COMPOSED_FRAGMENT_BANNER.replace("{{donor}}", path.basename(donorEntry.filePath));
    const fragmentBlockText = [banner, ...signalFragments.map((fragment) => fragment.text)].join("\n");
    baseBody.insertStatements(insertionIndex, fragmentBlockText);

    acceptedDonors.push(donorEntry.filePath);
    accumulatedFragmentTexts.push(...signalFragments.map((fragment) => fragment.text));
    totalFragmentCount += signalFragments.length;
  }

  if (acceptedDonors.length === 0) {
    return applyBaseTransformMutations({
      sourceFile: baseSourceFile,
      entry: baseEntry,
      teardown,
      compatibilityStatus,
      workingTreeDirty,
      knownFingerprint,
      executionMode,
      originalText: baseText
    });
  }

  const finalImportedAndDeclared = new Set([
    ...collectImportedNames(baseSourceFile),
    ...collectTopLevelDeclaredNames(baseSourceFile)
  ]);

  baseBody.getDescendantsOfKind(SyntaxKind.Identifier).forEach((identifier) => {
    const name = identifier.getText();
    const parent = identifier.getParent();
    if (parent && (Node.isPropertyAccessExpression(parent) || Node.isQualifiedName(parent))) {
      if (parent.getChildAtIndex(0) !== identifier) {
        return;
      }
    }
    if (isPlaywrightBuiltin(name) || isLanguagePrimitive(name)) {
      return;
    }
    if (finalImportedAndDeclared.has(name)) {
      return;
    }
    const scopeAware = identifier.getSymbol();
    if (scopeAware) {
      return;
    }
    throw new TugError(
      "COMPOSITION_UNRESOLVED_IDENTIFIER",
      `Composed spec references unresolved identifier "${name}".`,
      [name]
    );
  });

  const composition: CompositionInfo = {
    strategy: "ast-splice",
    baseSourceFile: baseEntry.filePath,
    donors: acceptedDonors,
    fragmentCount: totalFragmentCount
  };

  return applyBaseTransformMutations({
    sourceFile: baseSourceFile,
    entry: baseEntry,
    teardown,
    compatibilityStatus,
    workingTreeDirty,
    knownFingerprint,
    executionMode,
    originalText: baseText,
    composition
  });
};
