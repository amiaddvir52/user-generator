import type { CompatibilityStatus, RemovedCallsite } from "../common/types.js";

const round = (value: number) => Number(value.toFixed(4));

export const computeTransformConfidence = ({
  removedCalls,
  compatibilityStatus,
  singleTestMatch,
  workingTreeDirty
}: {
  removedCalls: RemovedCallsite[];
  compatibilityStatus: CompatibilityStatus;
  singleTestMatch: boolean;
  workingTreeDirty: boolean;
}) => {
  const minRemovedScore = removedCalls.length > 0 ? Math.min(...removedCalls.map((call) => call.score)) : 1;
  const fingerprintKnownFactor = compatibilityStatus === "supported" ? 1 : 0.85;
  const singleTestMatchFactor = singleTestMatch ? 1 : 0.7;
  const workingTreeFactor = workingTreeDirty ? 0.9 : 1;

  const confidence = round(minRemovedScore * fingerprintKnownFactor * singleTestMatchFactor * workingTreeFactor);

  return {
    confidence,
    breakdown: {
      minRemovedScore: round(minRemovedScore),
      fingerprintKnownFactor,
      singleTestMatchFactor,
      workingTreeFactor
    }
  };
};

export const assertConfidenceThreshold = ({
  confidence,
  interactive
}: {
  confidence: number;
  interactive: boolean;
}) => {
  const hardThreshold = 0.65;
  const confirmationThreshold = 0.8;

  if (confidence < hardThreshold) {
    return {
      ok: false,
      needsConfirmation: false
    };
  }

  if (confidence < confirmationThreshold) {
    return {
      ok: interactive,
      needsConfirmation: true
    };
  }

  return {
    ok: true,
    needsConfirmation: false
  };
};

