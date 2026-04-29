import path from "node:path";
import { SyntaxKind, type SourceFile } from "ts-morph";

export const rewriteRelativeImportsToAbsolute = ({
  sourceFile,
  sourceAbsolutePath
}: {
  sourceFile: SourceFile;
  sourceAbsolutePath: string;
}) => {
  const sourceDirectory = path.dirname(sourceAbsolutePath);

  sourceFile.getImportDeclarations().forEach((importDeclaration) => {
    const moduleSpecifier = importDeclaration.getModuleSpecifierValue();
    if (!moduleSpecifier.startsWith(".")) {
      return;
    }

    const resolved = path.resolve(sourceDirectory, moduleSpecifier).replace(/\\/g, "/");
    importDeclaration.setModuleSpecifier(resolved);
  });
};

const identifierIsUsed = (sourceFile: SourceFile, identifierName: string) => {
  const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
  return identifiers.filter((identifier) => identifier.getText() === identifierName).length > 1;
};

export const removeUnusedImportedSpecifiers = (sourceFile: SourceFile) => {
  sourceFile.getImportDeclarations().forEach((importDeclaration) => {
    importDeclaration.getNamedImports().forEach((namedImport) => {
      const identifierName = namedImport.getName();
      if (!identifierIsUsed(sourceFile, identifierName)) {
        namedImport.remove();
      }
    });

    const hasDefault = Boolean(importDeclaration.getDefaultImport());
    const hasNamespace = Boolean(importDeclaration.getNamespaceImport());
    const hasNamed = importDeclaration.getNamedImports().length > 0;

    if (!hasDefault && !hasNamespace && !hasNamed) {
      importDeclaration.remove();
    }
  });
};
