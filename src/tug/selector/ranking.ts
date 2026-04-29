import type { Intent, RankedCandidate, SpecIndexEntry } from "../common/types.js";
import { hasStandaloneKeyword } from "../common/text-signals.js";

type KeywordLocation = "title" | "describe" | "path" | "tag-exact" | "tag-contains";
type IntentKeywordClass = "action" | "context";

const LOCATION_WEIGHTS: Record<KeywordLocation, number> = {
  title: 1,
  describe: 0.75,
  path: 0.45,
  "tag-exact": 0.8,
  "tag-contains": 0.6
};

const LOCATION_LABELS: Record<KeywordLocation, string> = {
  title: "title",
  describe: "describe",
  path: "path",
  "tag-exact": "tag exact",
  "tag-contains": "tag contains"
};

const BASE_KEYWORD_SCORE = 0.14;
const CLOSE_SCORE_COST_TIEBREAK_WINDOW = 0.08;
const INTENT_MULTIPLIER: Record<IntentKeywordClass, number> = {
  action: 1.6,
  context: 1
};

const ACTION_KEYWORDS = new Set([
  "activate",
  "cancel",
  "convert",
  "create",
  "deactivate",
  "downgrade",
  "enroll",
  "migrate",
  "provision",
  "renew",
  "resubscribe",
  "signup",
  "subscribe",
  "terminate",
  "unsubscribe",
  "upgrade"
]);

const normalizeKeyword = (keyword: string) => keyword.toLowerCase().replace(/^@/, "").trim();

const resolveIntentKeywordClass = (keyword: string): IntentKeywordClass =>
  ACTION_KEYWORDS.has(normalizeKeyword(keyword)) ? "action" : "context";

const resolveKeywordLocation = (entry: SpecIndexEntry, keyword: string): KeywordLocation | undefined => {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    return undefined;
  }

  const tagExactMatch = entry.tags.some((tag) => {
    const normalizedTag = tag.toLowerCase();
    return normalizedTag === normalizedKeyword || normalizedTag === `@${normalizedKeyword}`;
  });
  const tagContainsMatch = !tagExactMatch && entry.tags.some((tag) => tag.toLowerCase().includes(normalizedKeyword));
  const titleMatch = hasStandaloneKeyword(entry.testTitle, normalizedKeyword);
  const describeMatch = entry.describeTitles.some((title) => hasStandaloneKeyword(title, normalizedKeyword));
  const pathMatch = hasStandaloneKeyword(entry.filePath, normalizedKeyword, {
    ignoreSlashDisjunction: false
  });

  const hits: KeywordLocation[] = [];
  if (titleMatch) {
    hits.push("title");
  }
  if (describeMatch) {
    hits.push("describe");
  }
  if (pathMatch) {
    hits.push("path");
  }
  if (tagExactMatch) {
    hits.push("tag-exact");
  } else if (tagContainsMatch) {
    hits.push("tag-contains");
  }

  if (hits.length === 0) {
    return undefined;
  }

  return hits.sort((left, right) => LOCATION_WEIGHTS[right] - LOCATION_WEIGHTS[left])[0];
};

const estimateExecutionCost = (entry: SpecIndexEntry) => {
  const directCallWeight = entry.teardownCalls.length * 1.5;
  const describeDepthWeight = entry.describeTitles.length;
  const titleLengthWeight = entry.testTitle.length > 120 ? 1 : 0;
  return directCallWeight + describeDepthWeight + titleLengthWeight;
};

export const scoreEntry = (entry: SpecIndexEntry, intent: Intent): RankedCandidate => {
  const reasons: string[] = [];
  let score = 0;

  intent.keywords.forEach((keyword) => {
    const location = resolveKeywordLocation(entry, keyword);
    if (!location) {
      return;
    }

    const intentClass = resolveIntentKeywordClass(keyword);
    const keywordScore = BASE_KEYWORD_SCORE * LOCATION_WEIGHTS[location] * INTENT_MULTIPLIER[intentClass];
    score += keywordScore;
    reasons.push(`keyword "${keyword}" (${intentClass}, ${LOCATION_LABELS[location]})`);
  });

  if (intent.hints.payerLocation && entry.scoreHints.payerLocation === intent.hints.payerLocation) {
    score += 0.2;
    reasons.push(`payer location ${intent.hints.payerLocation}`);
  }

  if (intent.hints.contractType && entry.scoreHints.contractType === intent.hints.contractType) {
    score += 0.2;
    reasons.push(`contract type ${intent.hints.contractType}`);
  }

  if (entry.helperImports.length > 0 && intent.keywords.some((keyword) => keyword.includes("helper"))) {
    score += 0.05;
    reasons.push("helper import affinity");
  }

  if (entry.testTitle.toLowerCase().includes(intent.rawPrompt.toLowerCase())) {
    score += 0.1;
    reasons.push("exact prompt snippet match");
  }

  const estimatedCost = estimateExecutionCost(entry);
  const costBonus = Math.max(0, 0.08 - Math.min(estimatedCost, 20) * 0.004);
  if (costBonus > 0) {
    score += costBonus;
    reasons.push("lower estimated execution cost");
  }

  return {
    entry,
    score: Number(score.toFixed(4)),
    reasons
  };
};

export const rankCandidates = (entries: SpecIndexEntry[], intent: Intent): RankedCandidate[] =>
  {
    const ranked = entries
    .map((entry) => scoreEntry(entry, intent))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        if (Math.abs(scoreDelta) <= CLOSE_SCORE_COST_TIEBREAK_WINDOW) {
          const closeCostDelta = estimateExecutionCost(left.entry) - estimateExecutionCost(right.entry);
          if (closeCostDelta !== 0) {
            return closeCostDelta;
          }
        }
        return scoreDelta;
      }

      const costDelta = estimateExecutionCost(left.entry) - estimateExecutionCost(right.entry);
      if (costDelta !== 0) {
        return costDelta;
      }

      if (left.entry.filePath !== right.entry.filePath) {
        return left.entry.filePath.localeCompare(right.entry.filePath);
      }

      return left.entry.testTitle.localeCompare(right.entry.testTitle);
    });

    if (ranked.length >= 2) {
      const [top, second] = ranked;
      if (Math.abs(top.score - second.score) <= CLOSE_SCORE_COST_TIEBREAK_WINDOW) {
        const costDelta = estimateExecutionCost(top.entry) - estimateExecutionCost(second.entry);
        if (costDelta < 0) {
          top.reasons.push("cost-aware tie-break winner (close-score window)");
        }
      }
    }

    return ranked;
  };
