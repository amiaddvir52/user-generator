import type { Intent, RankedCandidate, SpecIndexEntry } from "../common/types.js";

const toSearchText = (entry: SpecIndexEntry) =>
  `${entry.filePath} ${entry.describeTitles.join(" ")} ${entry.testTitle}`.toLowerCase();

const includesKeyword = (entry: SpecIndexEntry, keyword: string) => {
  const haystack = toSearchText(entry);
  if (haystack.includes(keyword)) {
    return true;
  }

  return entry.tags.some((tag) => tag.toLowerCase() === keyword || tag.toLowerCase().includes(keyword));
};

export const scoreEntry = (entry: SpecIndexEntry, intent: Intent): RankedCandidate => {
  const reasons: string[] = [];
  let score = 0;

  const keywordHits = intent.keywords.filter((keyword) => includesKeyword(entry, keyword));
  if (keywordHits.length > 0) {
    score += keywordHits.length * 0.22;
    reasons.push(`keyword match (${keywordHits.join(", ")})`);
  }

  if (entry.tags.length > 0) {
    const tagMatches = entry.tags.filter((tag) => intent.keywords.includes(tag.replace(/^@/, "")));
    if (tagMatches.length > 0) {
      score += tagMatches.length * 0.15;
      reasons.push(`tag match (${tagMatches.join(", ")})`);
    }
  }

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
    score += 0.35;
    reasons.push("exact prompt snippet match");
  }

  return {
    entry,
    score: Number(score.toFixed(4)),
    reasons
  };
};

export const rankCandidates = (entries: SpecIndexEntry[], intent: Intent): RankedCandidate[] =>
  entries
    .map((entry) => scoreEntry(entry, intent))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      if (left.entry.filePath !== right.entry.filePath) {
        return left.entry.filePath.localeCompare(right.entry.filePath);
      }

      return left.entry.testTitle.localeCompare(right.entry.testTitle);
    });

