import { loadRunContext } from "../../common/context.js";
import { printResult } from "../../common/output.js";
import { parseIntent } from "../../intent/parser.js";
import { getOrBuildIndex } from "../workflow.js";
import { runPreflightGates } from "../../validate/gates.js";
import { rankCandidates } from "../../selector/ranking.js";
import { computeAmbiguity } from "../../selector/ambiguity.js";

export const runExplainCommand = async (
  prompt: string,
  options: {
    repo?: string;
    top?: string;
    strict?: boolean;
    trustUnknown?: boolean;
    reindex?: boolean;
    json?: boolean;
  }
) => {
  const context = await loadRunContext({ repo: options.repo });
  const preflight = await runPreflightGates({
    repoPath: context.repoPath,
    strict: Boolean(options.strict),
    trustUnknown: Boolean(options.trustUnknown),
    dryList: false
  });

  const { index } = await getOrBuildIndex({
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    forceReindex: Boolean(options.reindex)
  });

  const intent = parseIntent(prompt);
  const ranked = rankCandidates(index.entries, intent);
  const top = Number(options.top ?? "5");
  const topRanked = ranked.slice(0, Number.isFinite(top) && top > 0 ? top : 5);
  const ambiguity = computeAmbiguity(ranked);

  const payload = {
    ok: true,
    fingerprint: preflight.fingerprint.fingerprint,
    intent,
    ambiguous: ambiguity.ambiguous,
    margin: ambiguity.margin,
    candidates: topRanked.map((candidate) => ({
      score: candidate.score,
      reasons: candidate.reasons,
      filePath: candidate.entry.filePath,
      title: candidate.entry.testTitle,
      describeTitles: candidate.entry.describeTitles
    }))
  };

  const lines = [
    `Fingerprint: ${preflight.fingerprint.fingerprint}`,
    `Ambiguous: ${ambiguity.ambiguous ? "yes" : "no"} (margin ${ambiguity.margin.toFixed(3)})`,
    "Candidates:"
  ];

  topRanked.forEach((candidate, indexPosition) => {
    lines.push(
      `${indexPosition + 1}. ${candidate.entry.testTitle} [${candidate.score.toFixed(2)}] (${candidate.entry.filePath})`
    );
    if (candidate.reasons.length > 0) {
      lines.push(`   reasons: ${candidate.reasons.join("; ")}`);
    }
  });

  printResult({
    json: Boolean(options.json),
    payload,
    text: lines.join("\n")
  });
};

