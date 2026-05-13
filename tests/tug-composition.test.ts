import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { parseIntent } from "../src/tug/intent/parser.js";
import { canonicalizeAction, isActionKeyword } from "../src/tug/intent/action-keywords.js";
import { selectCandidateDeterministically } from "../src/tug/selector/deterministic.js";
import { extractFragments } from "../src/tug/transform/fragment-extractor.js";
import { composeSyntheticSpec } from "../src/tug/transform/composer.js";
import { TugError } from "../src/tug/common/errors.js";
import type { SpecIndexEntry, TeardownDetectionResult } from "../src/tug/common/types.js";

const tempRoots: string[] = [];

const createTempDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tug-composition-"));
  tempRoots.push(directory);
  return directory;
};

const writeFile = async (root: string, relativePath: string, contents: string) => {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents, "utf8");
  return absolute;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const emptyTeardown: TeardownDetectionResult = {
  confirmed: [],
  suspected: [],
  scores: [],
  observedHookCalls: []
};

const buildEntry = (filePath: string, testTitle: string, overrides: Partial<SpecIndexEntry> = {}): SpecIndexEntry => ({
  filePath,
  testTitle,
  describeTitles: [],
  tags: [],
  helperImports: [],
  teardownCalls: [],
  scoreHints: {},
  ...overrides
});

describe("intent parser composition detection", () => {
  it("sets compose=true when prompt mentions two action keywords", () => {
    const intent = parseIntent("create account and upgrade subscription");
    expect(intent.compose).toBe(true);
  });

  it("leaves compose=false for single-action prompts", () => {
    const intent = parseIntent("create US on-demand account");
    expect(intent.compose).toBe(false);
  });

  it("recognizes synonyms via the action-keyword map", () => {
    const intent = parseIntent("add a US account and remove the subscription");
    expect(intent.compose).toBe(true);
  });

  it("collapses synonyms of the same canonical action (compose=false)", () => {
    // "make" and "create" both canonicalize to "create" → only one distinct action.
    const intent = parseIntent("make an account then create a backup account");
    expect(intent.compose).toBe(false);
  });

  it("handles morphology (-s / -ed / -ing)", () => {
    expect(parseIntent("creating an account and removing the subscription").compose).toBe(true);
    expect(parseIntent("upgraded plan and disabled feature").compose).toBe(true);
    expect(parseIntent("provisions account and migrates region").compose).toBe(true);
  });
});

describe("action-keyword canonicalization", () => {
  it("maps synonyms to canonical actions", () => {
    expect(canonicalizeAction("add")).toBe("create");
    expect(canonicalizeAction("remove")).toBe("delete");
    expect(canonicalizeAction("setup")).toBe("provision");
    expect(canonicalizeAction("enable")).toBe("activate");
  });

  it("strips common morphological suffixes", () => {
    expect(canonicalizeAction("creates")).toBe("create");
    expect(canonicalizeAction("creating")).toBe("create");
    expect(canonicalizeAction("created")).toBe("create");
    expect(canonicalizeAction("removed")).toBe("delete");
    expect(canonicalizeAction("upgrading")).toBe("upgrade");
  });

  it("returns undefined for non-action tokens", () => {
    expect(canonicalizeAction("account")).toBeUndefined();
    expect(canonicalizeAction("subscription")).toBeUndefined();
    expect(isActionKeyword("user")).toBe(false);
  });
});

describe("selector composition candidates", () => {
  it("returns compositionCandidates (donors only) when ambiguous", () => {
    const intent = parseIntent("upgrade");
    const selection = selectCandidateDeterministically({
      entries: [
        buildEntry("/tmp/a.spec.ts", "upgrade account"),
        buildEntry("/tmp/b.spec.ts", "upgrade marketplace")
      ],
      intent,
      requireUnambiguous: false
    });
    expect(selection.ambiguous).toBe(true);
    expect(selection.compositionCandidates.length).toBe(1);
    expect(selection.compositionCandidates[0].entry.filePath).not.toBe(selection.selected.entry.filePath);
  });

  it("returns compositionCandidates when intent.compose is true and base lacks actions", () => {
    const intent = parseIntent("create account and upgrade subscription");
    const selection = selectCandidateDeterministically({
      entries: [
        buildEntry("/tmp/create.spec.ts", "create account"),
        buildEntry("/tmp/upgrade.spec.ts", "upgrade subscription")
      ],
      intent,
      requireUnambiguous: false
    });
    expect(selection.compositionCandidates.length).toBe(1);
    expect(selection.compositionCandidates[0].entry.testTitle).not.toBe(selection.selected.entry.testTitle);
  });

  it("returns empty compositionCandidates when base test already covers all prompt actions", () => {
    // Prompt has two actions (create, upgrade), but a single test covers both — composition should be skipped.
    const intent = parseIntent("create account and upgrade subscription");
    expect(intent.compose).toBe(true);
    const selection = selectCandidateDeterministically({
      entries: [
        buildEntry("/tmp/combo.spec.ts", "create account and upgrade subscription"),
        buildEntry("/tmp/other.spec.ts", "cancel subscription")
      ],
      intent,
      requireUnambiguous: false
    });
    expect(selection.compositionCandidates).toEqual([]);
  });

  it("returns empty compositionCandidates for clear single-winner cases", () => {
    const intent = parseIntent("create US on-demand account");
    const selection = selectCandidateDeterministically({
      entries: [
        buildEntry("/tmp/a.spec.ts", "creates US on-demand account", {
          scoreHints: { payerLocation: "us", contractType: "on-demand" }
        }),
        buildEntry("/tmp/b.spec.ts", "deletes EU annual account", {
          scoreHints: { payerLocation: "eu", contractType: "annual" }
        })
      ],
      intent,
      requireUnambiguous: false
    });
    expect(selection.compositionCandidates).toEqual([]);
  });
});

describe("fragment extractor", () => {
  it("classifies setup / action / assertion statements", async () => {
    // loginHelper is imported from a registered helper module → demoted to setup.
    // createAccount is a free call (no helper import) → stays as a real action.
    const dir = await createTempDir();
    const specPath = await writeFile(
      dir,
      "sample.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { loginHelper } from '@playwright-helpers/login';",
        "test('creates account', async () => {",
        "  await loginHelper();",
        "  await createAccount();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );

    const fragments = await extractFragments({
      entry: buildEntry(specPath, "creates account", {
        helperImports: ["@playwright-helpers/login"]
      }),
      teardown: emptyTeardown
    });

    expect(fragments.map((fragment) => fragment.kind)).toEqual(["setup", "action", "assertion"]);
    expect(fragments[1].identifier).toBe("createAccount");
  });

  it("does NOT demote leading actions whose names merely look helper-like but aren't imported from a helper module", async () => {
    // Regression guard for the narrowed demotion: a real action named loginUser()
    // must stay an "action" so it gets considered for splicing into a composed spec.
    const dir = await createTempDir();
    const specPath = await writeFile(
      dir,
      "naming.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "test('logs user in', async () => {",
        "  await loginUser();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );

    const fragments = await extractFragments({
      entry: buildEntry(specPath, "logs user in", { helperImports: [] }),
      teardown: emptyTeardown
    });

    expect(fragments[0].kind).toBe("action");
    expect(fragments[0].identifier).toBe("loginUser");
  });

  it("classifies known teardown calls as teardown", async () => {
    const dir = await createTempDir();
    const specPath = await writeFile(
      dir,
      "teardown.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "test('cleans up', async () => {",
        "  await doWork();",
        "  expect(1).toBe(1);",
        "  await deleteResources();",
        "});",
        ""
      ].join("\n")
    );

    const fragments = await extractFragments({
      entry: buildEntry(specPath, "cleans up"),
      teardown: {
        confirmed: ["deleteResources"],
        suspected: [],
        scores: [{ identifier: "deleteResources", score: 0.9, pHook: 1, pName: 1, pTrans: 1, pOrigin: 1 }],
        observedHookCalls: []
      }
    });

    const teardownFragments = fragments.filter((fragment) => fragment.kind === "teardown");
    expect(teardownFragments).toHaveLength(1);
    expect(teardownFragments[0].identifier).toBe("deleteResources");
  });

  it("excludes property-access member names from referencedIdentifiers", async () => {
    const dir = await createTempDir();
    const specPath = await writeFile(
      dir,
      "props.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "test('navigates', async ({ page }) => {",
        "  await page.goto('https://example.com');",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );

    const fragments = await extractFragments({
      entry: buildEntry(specPath, "navigates"),
      teardown: emptyTeardown
    });

    const actionFragment = fragments.find((fragment) => fragment.kind === "action");
    expect(actionFragment).toBeDefined();
    expect(actionFragment!.referencedIdentifiers).toContain("page");
    // `goto` is a property name, not a free identifier — it must not be listed.
    expect(actionFragment!.referencedIdentifiers).not.toContain("goto");
  });
});

describe("composeSyntheticSpec", () => {
  it("splices donor action fragments into the base test body", async () => {
    const dir = await createTempDir();
    const basePath = await writeFile(
      dir,
      "base.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { createAccount } from './helpers';",
        "test('creates account', async () => {",
        "  await createAccount();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    const donorPath = await writeFile(
      dir,
      "donor.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { upgradeSubscription } from './helpers';",
        "test('upgrade subscription', async () => {",
        "  await upgradeSubscription();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    await writeFile(
      dir,
      "helpers.ts",
      "export const createAccount = async () => {};\nexport const upgradeSubscription = async () => {};\n"
    );

    const intent = parseIntent("create account and upgrade subscription");
    const baseEntry = buildEntry(basePath, "creates account");
    const donorEntry = buildEntry(donorPath, "upgrade subscription");

    const result = await composeSyntheticSpec({
      baseEntry,
      donorCandidates: [
        { entry: baseEntry, score: 1.0, reasons: [] },
        { entry: donorEntry, score: 0.95, reasons: [] }
      ],
      intent,
      teardown: emptyTeardown,
      compatibilityStatus: "supported",
      workingTreeDirty: false,
      knownFingerprint: true,
      executionMode: "full"
    });

    expect(result.composition).toBeDefined();
    expect(result.composition?.donors).toEqual([donorPath]);
    expect(result.transformedText).toContain("upgradeSubscription");
    expect(result.transformedText).toContain("createAccount");
    // confidence is downgraded for synthesized specs.
    expect(result.confidence).toBeLessThan(1);
  });

  it("falls back to base-only transform when no donor adds signal", async () => {
    const dir = await createTempDir();
    const basePath = await writeFile(
      dir,
      "base.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { createAccount } from './helpers';",
        "test('creates account', async () => {",
        "  await createAccount();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    const donorPath = await writeFile(
      dir,
      "donor.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { createAccount } from './helpers';",
        "test('creates account again', async () => {",
        "  await createAccount();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    await writeFile(dir, "helpers.ts", "export const createAccount = async () => {};\n");

    const intent = parseIntent("create account");
    const baseEntry = buildEntry(basePath, "creates account");
    const donorEntry = buildEntry(donorPath, "creates account again");

    const result = await composeSyntheticSpec({
      baseEntry,
      donorCandidates: [
        { entry: baseEntry, score: 1.0, reasons: [] },
        { entry: donorEntry, score: 0.95, reasons: [] }
      ],
      intent,
      teardown: emptyTeardown,
      compatibilityStatus: "supported",
      workingTreeDirty: false,
      knownFingerprint: true,
      executionMode: "full"
    });

    expect(result.composition).toBeUndefined();
  });

  it("splices donor fragments that use property-access (e.g. page.goto) on Playwright builtins", async () => {
    const dir = await createTempDir();
    const basePath = await writeFile(
      dir,
      "base.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { createAccount } from './helpers';",
        "test('creates account', async ({ page }) => {",
        "  await createAccount();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    const donorPath = await writeFile(
      dir,
      "donor.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { upgradeSubscription } from './helpers';",
        "test('upgrade subscription', async ({ page }) => {",
        "  await page.goto('https://example.com/upgrade');",
        "  await upgradeSubscription();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    await writeFile(
      dir,
      "helpers.ts",
      "export const createAccount = async () => {};\nexport const upgradeSubscription = async () => {};\n"
    );

    const intent = parseIntent("create account and upgrade subscription");
    const baseEntry = buildEntry(basePath, "creates account");
    const donorEntry = buildEntry(donorPath, "upgrade subscription");

    const result = await composeSyntheticSpec({
      baseEntry,
      donorCandidates: [
        { entry: baseEntry, score: 1.0, reasons: [] },
        { entry: donorEntry, score: 0.95, reasons: [] }
      ],
      intent,
      teardown: emptyTeardown,
      compatibilityStatus: "supported",
      workingTreeDirty: false,
      knownFingerprint: true,
      executionMode: "full"
    });

    expect(result.composition).toBeDefined();
    expect(result.transformedText).toContain("page.goto");
    expect(result.transformedText).toContain("upgradeSubscription");
  });

  it("merges donor imports into the base's existing import when they target the same module across different directories", async () => {
    // Base and donor each import a named export from the same helpers module, but via different relative paths
    // (because they live in different subdirectories). After composition, both names should resolve through a
    // single import declaration, not two duplicates — the donor's specifier must be expressed in base terms so
    // the merge step matches it against the base's existing declaration.
    const dir = await createTempDir();
    const basePath = await writeFile(
      dir,
      "specs/base/base.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { createAccount } from '../../helpers';",
        "test('creates account', async () => {",
        "  await createAccount();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    const donorPath = await writeFile(
      dir,
      "specs/donor/donor.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { upgradeSubscription } from '../../helpers';",
        "test('upgrade subscription', async () => {",
        "  await upgradeSubscription();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    await writeFile(
      dir,
      "helpers.ts",
      "export const createAccount = async () => {};\nexport const upgradeSubscription = async () => {};\n"
    );

    const intent = parseIntent("create account and upgrade subscription");
    const baseEntry = buildEntry(basePath, "creates account");
    const donorEntry = buildEntry(donorPath, "upgrade subscription");

    const result = await composeSyntheticSpec({
      baseEntry,
      donorCandidates: [
        { entry: baseEntry, score: 1.0, reasons: [] },
        { entry: donorEntry, score: 0.95, reasons: [] }
      ],
      intent,
      teardown: emptyTeardown,
      compatibilityStatus: "supported",
      workingTreeDirty: false,
      knownFingerprint: true,
      executionMode: "full"
    });

    expect(result.composition).toBeDefined();
    expect(result.transformedText).toContain("upgradeSubscription");
    // One — and only one — import declaration should bring in both names from the helpers module.
    const helpersImports = result.transformedText
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) && line.includes("helpers"));
    expect(helpersImports).toHaveLength(1);
    expect(helpersImports[0]).toContain("createAccount");
    expect(helpersImports[0]).toContain("upgradeSubscription");
  });

  it("fails closed when donor fragment references unimportable identifier", async () => {
    const dir = await createTempDir();
    const basePath = await writeFile(
      dir,
      "base.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "test('creates account', async () => {",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    const donorPath = await writeFile(
      dir,
      "donor.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "test('mystery upgrade', async () => {",
        "  await mysteryUpgrade();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );

    const intent = parseIntent("create account and upgrade subscription");
    const baseEntry = buildEntry(basePath, "creates account");
    const donorEntry = buildEntry(donorPath, "mystery upgrade");

    let caught: unknown;
    try {
      await composeSyntheticSpec({
        baseEntry,
        donorCandidates: [
          { entry: baseEntry, score: 1.0, reasons: [] },
          { entry: donorEntry, score: 0.95, reasons: [] }
        ],
        intent,
        teardown: emptyTeardown,
        compatibilityStatus: "supported",
        workingTreeDirty: false,
        knownFingerprint: true,
        executionMode: "full"
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TugError);
    expect((caught as TugError).reason).toBe("COMPOSITION_FRAGMENT_INCOMPATIBLE");
  });

  it("throws COMPOSITION_NO_VIABLE_DONORS when compose was requested but no donor adds signal", async () => {
    // Prompt mentions two canonical actions (compose=true), but the only donor
    // duplicates the base test's calls — nothing new to splice. The composer
    // must fail closed instead of silently running a base test that doesn't
    // cover the second action.
    const dir = await createTempDir();
    const basePath = await writeFile(
      dir,
      "base.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { createAccount } from './helpers';",
        "test('creates account', async () => {",
        "  await createAccount();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    const donorPath = await writeFile(
      dir,
      "donor.spec.ts",
      [
        "import { test, expect } from '@playwright/test';",
        "import { createAccount } from './helpers';",
        "test('creates account again', async () => {",
        "  await createAccount();",
        "  expect(true).toBe(true);",
        "});",
        ""
      ].join("\n")
    );
    await writeFile(dir, "helpers.ts", "export const createAccount = async () => {};\n");

    const intent = parseIntent("create account and upgrade subscription");
    expect(intent.compose).toBe(true);
    const baseEntry = buildEntry(basePath, "creates account");
    const donorEntry = buildEntry(donorPath, "creates account again");

    let caught: unknown;
    try {
      await composeSyntheticSpec({
        baseEntry,
        donorCandidates: [
          { entry: baseEntry, score: 1.0, reasons: [] },
          { entry: donorEntry, score: 0.95, reasons: [] }
        ],
        intent,
        teardown: emptyTeardown,
        compatibilityStatus: "supported",
        workingTreeDirty: false,
        knownFingerprint: true,
        executionMode: "full"
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TugError);
    expect((caught as TugError).reason).toBe("COMPOSITION_NO_VIABLE_DONORS");
  });
});
