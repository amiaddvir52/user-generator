import { describe, expect, it } from "vitest";

import { ensureRequiredEnvironment } from "../src/tug/validate/env-check.js";

describe("ensureRequiredEnvironment", () => {
  it("accepts supported canonical and runtime environment values", () => {
    expect(() => ensureRequiredEnvironment({ environment: "k8s-billing" })).not.toThrow();
    expect(() =>
      ensureRequiredEnvironment({ environment: "sm.k8s-billing.sm-qa.qa" })
    ).not.toThrow();
  });

  it("rejects unsupported values", () => {
    expect(() => ensureRequiredEnvironment({ environment: "staging.qa" })).toThrow(
      "Environment staging.qa is not supported."
    );
  });
});
