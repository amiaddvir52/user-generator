import { TugError } from "../common/errors.js";
import type { Intent, SelectionResult, SpecIndexEntry } from "../common/types.js";
import { computeAmbiguity } from "./ambiguity.js";
import { rankCandidates } from "./ranking.js";

export const selectCandidateDeterministically = ({
  entries,
  intent,
  requireUnambiguous
}: {
  entries: SpecIndexEntry[];
  intent: Intent;
  requireUnambiguous: boolean;
}): SelectionResult => {
  const ranked = rankCandidates(entries, intent);

  if (ranked.length === 0) {
    throw new TugError(
      "CANDIDATE_AMBIGUOUS",
      "No indexed tests matched the prompt."
    );
  }

  const { ambiguous, margin } = computeAmbiguity(ranked);

  if (requireUnambiguous && ambiguous) {
    const topChoices = ranked.slice(0, 3).map((candidate) => `${candidate.entry.testTitle} (${candidate.entry.filePath})`);
    throw new TugError(
      "CANDIDATE_AMBIGUOUS",
      "Multiple candidate tests matched with close scores.",
      topChoices
    );
  }

  return {
    selected: ranked[0],
    ranked,
    ambiguous,
    margin
  };
};

