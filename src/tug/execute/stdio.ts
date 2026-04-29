import { promises as fs } from "node:fs";

export const appendLog = async (filePath: string, line: string) => {
  await fs.appendFile(filePath, line, "utf8");
};

export const readBufferedLines = ({
  chunk,
  remainder
}: {
  chunk: string;
  remainder: string;
}) => {
  const combined = `${remainder}${chunk}`;
  const segments = combined.split(/\r?\n/);
  const nextRemainder = segments.pop() ?? "";

  return {
    lines: segments.filter((line) => line.length > 0),
    remainder: nextRemainder
  };
};

export const flushBufferedLines = (remainder: string) =>
  remainder.length > 0 ? [remainder] : [];
