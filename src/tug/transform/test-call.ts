import { Node, SyntaxKind, type Block, type CallExpression, type SourceFile } from "ts-morph";

export const TEST_PATTERN = /(^|\.)test(?:\.(only|skip|fixme|fail))?$/;

export const findTestCall = (sourceFile: SourceFile, testTitle: string): CallExpression | undefined => {
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

export const getTestBody = (callExpression: CallExpression): Block | undefined => {
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

const collectBindingNames = (nameNode: Node, out: Set<string>) => {
  if (Node.isIdentifier(nameNode)) {
    out.add(nameNode.getText());
    return;
  }
  nameNode.getDescendantsOfKind(SyntaxKind.Identifier).forEach((identifier) => {
    out.add(identifier.getText());
  });
};

// Collects every identifier brought into scope inside a test body: the enclosing
// callback's parameters plus any variable / parameter / function / class
// declarations anywhere within the body. Conservative — it ignores TDZ and inner
// scope boundaries — which is what we want for a fail-closed unresolved-identifier
// sweep: anything actually undefined is still undefined.
export const collectBodyDeclaredNames = (body: Block): Set<string> => {
  const names = new Set<string>();

  const parent = body.getParent();
  if (parent && Node.isFunctionLikeDeclaration(parent)) {
    parent.getParameters().forEach((parameter) => {
      collectBindingNames(parameter.getNameNode(), names);
    });
  }

  body.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((declaration) => {
    collectBindingNames(declaration.getNameNode(), names);
  });
  body.getDescendantsOfKind(SyntaxKind.Parameter).forEach((parameter) => {
    collectBindingNames(parameter.getNameNode(), names);
  });
  body.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).forEach((declaration) => {
    const name = declaration.getName();
    if (name) names.add(name);
  });
  body.getDescendantsOfKind(SyntaxKind.ClassDeclaration).forEach((declaration) => {
    const name = declaration.getName();
    if (name) names.add(name);
  });

  return names;
};
