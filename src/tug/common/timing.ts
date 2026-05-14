import type { RunTiming } from "./types.js";

const formatMs = (ms: number | undefined): string =>
  ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`;

export const formatRunTimingSummary = (timing: RunTiming): string => {
  const segments: string[] = [
    `preflight ${formatMs(timing.preflightMs)}`,
    `index ${formatMs(timing.indexMs)}`,
    `selection ${formatMs(timing.selectionMs)}`,
    `transform ${formatMs(timing.transformMs)}`,
    `execute ${formatMs(timing.executeMs)}`
  ];

  if (timing.sandboxBuildMs !== undefined) {
    segments.push(`sandboxBuild ${formatMs(timing.sandboxBuildMs)}`);
  }
  if (timing.sandboxValidationMs !== undefined) {
    segments.push(`sandboxValidation ${formatMs(timing.sandboxValidationMs)}`);
  }
  if (timing.cleanupMs !== undefined) {
    segments.push(`cleanup ${formatMs(timing.cleanupMs)}`);
  }
  if (timing.fallbackMs !== undefined) {
    segments.push(`fallback ${formatMs(timing.fallbackMs)}`);
  }

  segments.push(`total ${formatMs(timing.totalMs)}`);

  return `Timing — ${segments.join(" | ")}`;
};
