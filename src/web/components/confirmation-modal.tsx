import React from "react";

import type { PendingConfirmation, UserGenerationRequest } from "../lib/types.js";
import { describeConfirmation } from "../lib/helpers.js";
import { Button, InlineCode } from "./primitives.js";

type ConfirmationModalProps = {
  isGenerating: boolean;
  pendingConfirmation: PendingConfirmation | null;
  onClose: () => void;
  onConfirmAmbiguousCandidate: (choice: string) => void;
  onConfirmWithOverrides: (overrides: Partial<UserGenerationRequest>) => void;
};

export const ConfirmationModal = ({
  isGenerating,
  pendingConfirmation,
  onClose,
  onConfirmAmbiguousCandidate,
  onConfirmWithOverrides
}: ConfirmationModalProps) => {
  if (!pendingConfirmation) {
    return null;
  }

  const { error } = pendingConfirmation;

  const title =
    error.reason === "CANDIDATE_AMBIGUOUS"
      ? "Multiple candidate tests matched"
      : "Confirmation required";

  const isAmbiguous = error.reason === "CANDIDATE_AMBIGUOUS";
  const isTeardownUnsure = error.reason === "TEARDOWN_IDENTITY_UNSURE";
  const isUnknownFingerprint = error.reason === "FINGERPRINT_UNKNOWN";

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirmation-title">
      <div className="modal-card">
        <h3 id="confirmation-title">{title}</h3>
        <p className="helper-text">{describeConfirmation(error)}</p>

        {error.details && error.details.length > 0 && (
          <ul className="choice-warnings">
            {error.details.map((detail) => (
              <li key={detail}>
                {isAmbiguous ? (
                  <button
                    className="modal-link"
                    disabled={isGenerating}
                    onClick={() => onConfirmAmbiguousCandidate(detail)}
                    type="button"
                  >
                    Use this candidate: <InlineCode>{detail}</InlineCode>
                  </button>
                ) : (
                  <InlineCode>{detail}</InlineCode>
                )}
              </li>
            ))}
          </ul>
        )}

        {error.logFile && (
          <p className="helper-text">
            Run log: <InlineCode>{error.logFile}</InlineCode>
          </p>
        )}

        <div className="action-row">
          {isUnknownFingerprint && (
            <Button
              disabled={isGenerating}
              onClick={() => onConfirmWithOverrides({ trustUnknown: true })}
            >
              {isGenerating ? "Running" : "Trust fingerprint and run"}
            </Button>
          )}
          {isTeardownUnsure && (
            <Button
              disabled={isGenerating}
              onClick={() => onConfirmWithOverrides({ trustUncertainTeardown: true })}
            >
              {isGenerating ? "Running" : "Accept and run"}
            </Button>
          )}
          <Button disabled={isGenerating} onClick={onClose} tone="secondary">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
};
