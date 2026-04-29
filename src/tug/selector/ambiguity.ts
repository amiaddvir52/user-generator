import type { RankedCandidate } from "../common/types.js";

export const computeAmbiguity = (ranked: RankedCandidate[]) => {
  if (ranked.length < 2) {
    return {
      ambiguous: false,
      margin: 1
    };
  }

  const top = ranked[0].score;
  const second = ranked[1].score;
  const margin = Number((top - second).toFixed(4));

  return {
    ambiguous: margin < 0.15,
    margin
  };
};

