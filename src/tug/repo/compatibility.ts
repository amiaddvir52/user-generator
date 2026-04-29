import { promises as fs } from "node:fs";
import path from "node:path";

import { compatibilityManifest } from "../manifest/compatibility.js";
import type { CompatibilityResult, FingerprintInfo } from "../common/types.js";
import { TugError } from "../common/errors.js";

const OVERRIDE_FILE_NAME = "compatibility-overrides.json";

type CompatibilityOverrides = {
  fingerprints?: Record<string, { notes?: string; teardownIdentifiers?: string[] }>;
};

const resolveOverridePath = () =>
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "", ".config"), "test-user-generator", OVERRIDE_FILE_NAME);

const loadOverrides = async (): Promise<CompatibilityOverrides> => {
  const overridePath = resolveOverridePath();
  try {
    const raw = await fs.readFile(overridePath, "utf8");
    return JSON.parse(raw) as CompatibilityOverrides;
  } catch {
    return {};
  }
};

export const saveCompatibilityOverride = async ({
  fingerprint,
  notes,
  teardownIdentifiers
}: {
  fingerprint: string;
  notes?: string;
  teardownIdentifiers?: string[];
}) => {
  const overridePath = resolveOverridePath();
  const existing = await loadOverrides();
  const next: CompatibilityOverrides = {
    fingerprints: {
      ...(existing.fingerprints ?? {}),
      [fingerprint]: {
        notes,
        teardownIdentifiers
      }
    }
  };

  await fs.mkdir(path.dirname(overridePath), { recursive: true });
  await fs.writeFile(overridePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
};

export const evaluateCompatibility = async ({
  fingerprint,
  trustUnknown
}: {
  fingerprint: FingerprintInfo;
  trustUnknown: boolean;
}): Promise<CompatibilityResult> => {
  const known = compatibilityManifest.fingerprints[fingerprint.fingerprint];
  if (known) {
    return {
      status: "supported",
      fingerprint: fingerprint.fingerprint,
      notes: known.notes,
      knownTeardownHints: known.teardownIdentifiers
    };
  }

  const overrides = await loadOverrides();
  const override = overrides.fingerprints?.[fingerprint.fingerprint];
  if (override) {
    return {
      status: "experimental",
      fingerprint: fingerprint.fingerprint,
      notes: override.notes,
      knownTeardownHints: override.teardownIdentifiers ?? []
    };
  }

  if (!trustUnknown) {
    throw new TugError(
      "FINGERPRINT_UNKNOWN",
      `Fingerprint ${fingerprint.fingerprint} is unknown and execution is blocked by default.`,
      ["Rerun with --trust-unknown to explicitly opt in."]
    );
  }

  return {
    status: "experimental",
    fingerprint: fingerprint.fingerprint,
    notes: "Unknown fingerprint accepted via --trust-unknown.",
    knownTeardownHints: []
  };
};

