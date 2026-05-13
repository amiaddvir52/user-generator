import { TugError } from "../common/errors.js";
import type { Intent, RankedCandidate, SelectionResult, SpecIndexEntry } from "../common/types.js";
import { canonicalizeAction } from "../intent/action-keywords.js";
import { computeAmbiguity } from "./ambiguity.js";
import { rankCandidates } from "./ranking.js";

const MAX_COMPOSITION_DONORS = 2;

const canonicalActionsIn = (tokens: Iterable<string>): Set<string> => {
  const actions = new Set<string>();
  for (const token of tokens) {
    if (!token) continue;
    for (const part of token.toLowerCase().split(/[^a-z0-9]+/)) {
      const canonical = canonicalizeAction(part);
      if (canonical) {
        actions.add(canonical);
      }
    }
  }
  return actions;
};

const baseCoversAllPromptActions = (base: RankedCandidate, intent: Intent): boolean => {
  const promptActions = canonicalActionsIn(intent.keywords);
  if (promptActions.size === 0) {
    return false;
  }
  const baseTokens = [base.entry.testTitle, ...base.entry.describeTitles];
  const baseActions = canonicalActionsIn(baseTokens);
  for (const action of promptActions) {
    if (!baseActions.has(action)) {
      return false;
    }
  }
  return true;
};

const collectCompositionCandidates = (
  ranked: RankedCandidate[],
  intent: Intent,
  ambiguous: boolean
): RankedCandidate[] => {
  if (ranked.length < 2) {
    return [];
  }
  if (!ambiguous) {
    if (!intent.compose) {
      return [];
    }
    if (baseCoversAllPromptActions(ranked[0], intent)) {
      return [];
    }
  }

  return ranked.slice(1, MAX_COMPOSITION_DONORS + 1);
};

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

  if (requireUnambiguous && ambiguous && !intent.compose) {
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
    margin,
    compositionCandidates: collectCompositionCandidates(ranked, intent, ambiguous)
  };
};
