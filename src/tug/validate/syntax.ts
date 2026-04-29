import { Project } from "ts-morph";

import { TugError } from "../common/errors.js";

export const validateSyntaxRoundTrip = (sourceText: string, filePath = "gen.spec.ts") => {
  const project = new Project({
    skipAddingFilesFromTsConfig: true
  });
  const sourceFile = project.createSourceFile(filePath, sourceText, { overwrite: true });
  const diagnostics = project.getProgram().getSyntacticDiagnostics(sourceFile);

  if (diagnostics.length > 0) {
    throw new TugError("VALIDATION_FAILED", "Syntax validation failed for transformed source.", diagnostics.slice(0, 5).map((diagnostic) => diagnostic.getMessageText().toString()));
  }
};

