import { IntentSchema } from "./schema.js";
import type { Intent } from "../common/types.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "with",
  "for",
  "to",
  "in",
  "of",
  "on",
  "by",
  "from",
  "user",
  "account"
]);

const tokenize = (input: string) =>
  input
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

export const parseIntent = (prompt: string): Intent => {
  const keywords = [...new Set(tokenize(prompt))];

  const lowered = prompt.toLowerCase();
  const hints = {
    payerLocation: lowered.includes("us")
      ? "us"
      : lowered.includes("eu")
        ? "eu"
        : lowered.includes("gcp")
          ? "gcp"
          : undefined,
    contractType: lowered.includes("on-demand")
      ? "on-demand"
      : lowered.includes("annual")
        ? "annual"
        : lowered.includes("monthly")
          ? "monthly"
          : undefined
  };

  return IntentSchema.parse({
    rawPrompt: prompt,
    keywords,
    hints
  });
};

