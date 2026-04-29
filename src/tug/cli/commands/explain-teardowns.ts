import { loadRunContext } from "../../common/context.js";
import { printResult } from "../../common/output.js";
import { getOrBuildIndex } from "../workflow.js";
import { runPreflightGates } from "../../validate/gates.js";

export const runExplainTeardownsCommand = async (options: {
  repo?: string;
  reindex?: boolean;
  strict?: boolean;
  trustUnknown?: boolean;
  json?: boolean;
}) => {
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

  const payload = {
    ok: true,
    fingerprint: preflight.fingerprint.fingerprint,
    confirmed: index.teardown.confirmed,
    suspected: index.teardown.suspected,
    scores: index.teardown.scores
  };

  const textLines = [
    `Fingerprint: ${preflight.fingerprint.fingerprint}`,
    `Confirmed: ${index.teardown.confirmed.join(", ") || "(none)"}`,
    `Suspected: ${index.teardown.suspected.join(", ") || "(none)"}`,
    "Scores:"
  ];

  index.teardown.scores.slice(0, 30).forEach((score) => {
    textLines.push(
      `- ${score.identifier}: ${score.score.toFixed(2)} (hook=${score.pHook.toFixed(2)}, name=${score.pName.toFixed(2)}, trans=${score.pTrans.toFixed(2)}, origin=${score.pOrigin.toFixed(2)})`
    );
  });

  printResult({
    json: Boolean(options.json),
    payload,
    text: textLines.join("\n")
  });
};

