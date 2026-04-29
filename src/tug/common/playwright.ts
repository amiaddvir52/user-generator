import type { SpecIndexEntry } from "./types.js";

type TestSelector = Pick<SpecIndexEntry, "describeTitles" | "testTitle">;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const buildPlaywrightTitlePath = ({ describeTitles, testTitle }: TestSelector) =>
  [...describeTitles, testTitle].join(" ").trim();

const buildFlexibleTitleSegments = ({ describeTitles, testTitle }: TestSelector) =>
  [...describeTitles, testTitle].map((segment) => segment.trim()).filter((segment) => segment.length > 0);

export const buildPlaywrightGrepPattern = (selector: TestSelector) =>
  buildFlexibleTitleSegments(selector).map(escapeRegExp).join(".*");

export const buildPlaywrightDisplayTitle = ({ describeTitles, testTitle }: TestSelector) =>
  [...describeTitles, testTitle].join(" › ").trim();
