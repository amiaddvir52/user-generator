export const generateTsConfig = ({
  baseTsconfigPath
}: {
  baseTsconfigPath: string;
}) =>
  JSON.stringify(
    {
      extends: baseTsconfigPath.replace(/\\/g, "/"),
      compilerOptions: {
        rootDir: null,
        noEmit: true
      },
      include: ["gen.spec.ts"]
    },
    null,
    2
  ) + "\n";

