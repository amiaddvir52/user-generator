import { IntentSchema } from "./schema.js";
import type { Intent } from "../common/types.js";
import { extractScoreHintsFromText } from "./hints.js";

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
  "account",
  "mp",
  "plan"
]);

const tokenize = (input: string) =>
  input
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

export const parseIntent = (prompt: string): Intent => {
  const keywords = [...new Set(tokenize(prompt))];
  const hints = extractScoreHintsFromText(prompt);

  return IntentSchema.parse({
    rawPrompt: prompt,
    keywords,
    hints
  });
};
