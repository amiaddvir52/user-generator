import { loadRunContext } from "../../common/context.js";
import { printResult } from "../../common/output.js";
import { getOrBuildIndex } from "../workflow.js";
import { runPreflightGates } from "../../validate/gates.js";

export const runIndexCommand = async (options: {
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

  const indexResult = await getOrBuildIndex({
    repo: preflight.repo,
    fingerprint: preflight.fingerprint.fingerprint,
    compatibility: preflight.compatibility,
    forceReindex: Boolean(options.reindex)
  });

  const payload = {
    ok: true,
    fingerprint: preflight.fingerprint.fingerprint,
    entries: indexResult.index.entries.length,
    confirmedTeardowns: indexResult.index.teardown.confirmed,
    suspectedTeardowns: indexResult.index.teardown.suspected,
    loadedFromCache: indexResult.loadedFromCache,
    cachePath: indexResult.cachePath
  };

  printResult({
    json: Boolean(options.json),
    payload,
    text: [
      `Indexed ${indexResult.index.entries.length} tests for ${preflight.fingerprint.fingerprint}.`,
      `Confirmed teardowns: ${indexResult.index.teardown.confirmed.length}`,
      `Suspected teardowns: ${indexResult.index.teardown.suspected.length}`,
      indexResult.loadedFromCache ? "Loaded from cache." : `Cache written: ${indexResult.cachePath}`
    ].join("\n")
  });
};

