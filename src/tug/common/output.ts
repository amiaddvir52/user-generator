import { promises as fs } from "node:fs";

import { asTugError, toReasonLine } from "./errors.js";

export const printResult = ({
  json,
  payload,
  text
}: {
  json: boolean;
  payload: Record<string, unknown>;
  text: string;
}) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${text}\n`);
};

export const printErrorAndExit = ({
  json,
  error
}: {
  json: boolean;
  error: unknown;
}): never => {
  const tugError = asTugError(error);

  if (json) {
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          reason: tugError.reason,
          message: tugError.message,
          details: tugError.details
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stderr.write(`${tugError.message}\n`);
    process.stderr.write(`${toReasonLine(tugError)}\n`);
    if (tugError.details.length > 0) {
      tugError.details.forEach((detail) => {
        process.stderr.write(`- ${detail}\n`);
      });
    }
  }

  process.exit(tugError.exitCode);
};

export const writeJsonFile = async (filePath: string, value: unknown) => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
};

