import path from "node:path";
import { promises as fs } from "node:fs";
import { Node, Project, SyntaxKind, type Block, type SourceFile } from "ts-morph";

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
import { collectBodyDeclaredNames, findTestCall, getTestBody } from "./test-call.js";
import { applyBaseTransformMutations } from "./transformer.js";

// `//`-line banner so a donor filename containing `*/` can't terminate a block
// comment and inject syntax after it.
const buildBanner = (donorFilePath: string): string =>
  `// tug: composed fragment from ${path.basename(donorFilePath).replace(/[\r\n]/g, " ")}`;

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

  const seenDonorKeys = new Set<string>();
  const donorOnly = donorCandidates.filter((candidate) => {
    if (
      candidate.entry.filePath === baseEntry.filePath &&
      candidate.entry.testTitle === baseEntry.testTitle
    ) {
      return false;
    }
    const key = `${candidate.entry.filePath}::${candidate.entry.testTitle}`;
    if (seenDonorKeys.has(key)) {
      return false;
    }
    seenDonorKeys.add(key);
    return true;
  });

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
    const banner = buildBanner(donorEntry.filePath);
    const fragmentBlockText = [banner, ...signalFragments.map((fragment) => fragment.text)].join("\n");
    baseBody.insertStatements(insertionIndex, fragmentBlockText);

    acceptedDonors.push(donorEntry.filePath);
    accumulatedFragmentTexts.push(...signalFragments.map((fragment) => fragment.text));
    totalFragmentCount += signalFragments.length;
  }

  if (acceptedDonors.length === 0) {
    // The caller explicitly asked for composition (multi-action prompt) but no
    // donor fragment contributed new keyword/hint signal. Fail closed so the
    // user knows the prompt's extra actions weren't covered, instead of
    // silently running a base test that only covers part of the request.
    if (intent.compose) {
      throw new TugError(
        "COMPOSITION_NO_VIABLE_DONORS",
        "Composition was requested but no donor candidate added new signal over the base test."
      );
    }
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

  const finalInScopeNames = new Set([
    ...collectImportedNames(baseSourceFile),
    ...collectTopLevelDeclaredNames(baseSourceFile),
    ...collectBodyDeclaredNames(baseBody)
  ]);

  baseBody.getDescendantsOfKind(SyntaxKind.Identifier).forEach((identifier) => {
    const name = identifier.getText();
    const parent = identifier.getParent();
    if (parent && (Node.isPropertyAccessExpression(parent) || Node.isQualifiedName(parent))) {
      if (parent.getChildAtIndex(0) !== identifier) {
        return;
      }
    }
    // Skip identifier positions that *introduce* a binding rather than
    // reference one (variable/parameter/function/class names, property keys).
    if (parent) {
      if (Node.isVariableDeclaration(parent) && parent.getNameNode() === identifier) return;
      if (Node.isParameterDeclaration(parent) && parent.getNameNode() === identifier) return;
      if (Node.isFunctionDeclaration(parent) && parent.getNameNode() === identifier) return;
      if (Node.isClassDeclaration(parent) && parent.getNameNode() === identifier) return;
      if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) return;
      if (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === identifier) {
        // shorthand `{ foo }` — `foo` IS a reference; do not skip
      }
      if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === identifier) return;
    }
    if (isPlaywrightBuiltin(name) || isLanguagePrimitive(name)) {
      return;
    }
    if (finalInScopeNames.has(name)) {
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
