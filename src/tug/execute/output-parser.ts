import { CREDENTIAL_MARKER } from "../transform/credential-probe.js";
import { TugError } from "../common/errors.js";
import type { CredentialPayload } from "../common/types.js";

export const parseCredentialMarker = (lines: string[]): CredentialPayload => {
  const markerLine = [...lines].reverse().find((line) => line.includes(CREDENTIAL_MARKER));
  if (!markerLine) {
    throw new TugError(
      "CREDENTIAL_MARKER_MISSING",
      "Execution completed without emitting a credential marker."
    );
  }

  const markerIndex = markerLine.indexOf(CREDENTIAL_MARKER);
  const payloadRaw = markerLine.slice(markerIndex + CREDENTIAL_MARKER.length).trim();

  try {
    const payload = JSON.parse(payloadRaw) as CredentialPayload;
    return payload;
  } catch {
    throw new TugError(
      "CREDENTIAL_MARKER_MISSING",
      "Credential marker was found but could not be parsed as JSON.",
      [payloadRaw]
    );
  }
};

