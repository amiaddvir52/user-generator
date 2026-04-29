import type { ScoreHints } from "../common/types.js";
import { firstMatchingKeyword } from "../common/text-signals.js";

const LOCATION_HINTS: Array<{ value: NonNullable<ScoreHints["payerLocation"]>; keywords: string[] }> = [
  {
    value: "us",
    keywords: ["us", "usa"]
  },
  {
    value: "eu",
    keywords: ["eu"]
  },
  {
    value: "gcp",
    keywords: ["gcp"]
  }
];

const CONTRACT_HINTS: Array<{ value: NonNullable<ScoreHints["contractType"]>; keywords: string[] }> = [
  {
    value: "on-demand",
    keywords: ["on-demand"]
  },
  {
    value: "annual",
    keywords: ["annual"]
  },
  {
    value: "monthly",
    keywords: ["monthly"]
  }
];

export const extractScoreHintsFromText = (input: string): ScoreHints => {
  const normalized = input.toLowerCase();

  const payerLocation = LOCATION_HINTS.find((candidate) =>
    Boolean(firstMatchingKeyword(normalized, candidate.keywords))
  )?.value;

  const contractType = CONTRACT_HINTS.find((candidate) =>
    Boolean(firstMatchingKeyword(normalized, candidate.keywords))
  )?.value;

  return {
    payerLocation,
    contractType
  };
};
