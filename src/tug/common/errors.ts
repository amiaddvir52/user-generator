import type { ReasonCode } from "./types.js";

const DEFAULT_EXIT_CODE = 1;

export class TugError extends Error {
  readonly reason: ReasonCode;
  readonly details: string[];
  readonly exitCode: number;

  constructor(reason: ReasonCode, message: string, details: string[] = [], exitCode = DEFAULT_EXIT_CODE) {
    super(message);
    this.name = "TugError";
    this.reason = reason;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export const isTugError = (error: unknown): error is TugError => error instanceof TugError;

export const asTugError = (error: unknown): TugError => {
  if (isTugError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new TugError("UNKNOWN_ERROR", error.message);
  }

  return new TugError("UNKNOWN_ERROR", String(error));
};

export const toReasonLine = (error: TugError) => `Reason: ${error.reason}`;

