import { describe, expect, it } from "vitest";

import { buildExecutionEnv } from "../src/tug/common/runtime-env.js";

describe("buildExecutionEnv", () => {
  it("resolves supported environment aliases for execution", () => {
    const env = buildExecutionEnv({
      baseEnv: {
        region: "us-central1"
      },
      environment: "k8s-integration"
    });

    expect(env.env).toBe("sm.k8s-integration.sm-qa.qa");
    expect(env.TUG_ENVIRONMENT).toBe("k8s-integration");
    expect(env.cloudProvider).toBe("gcp");
    expect(env.cloudService).toBe("gcp");
    expect(env.marketplace).toBe("gcp");
    expect(env.region).toBe("us-central1");
  });

  it("fills missing cloudProvider from cloudService", () => {
    const env = buildExecutionEnv({
      baseEnv: {
        cloudService: "aws"
      }
    });

    expect(env.cloudProvider).toBe("aws");
    expect(env.cloudService).toBe("aws");
    expect(env.region).toBe("us-east-1");
  });

  it("infers provider from region when provider aliases are absent", () => {
    const env = buildExecutionEnv({
      baseEnv: {
        region: "us-central1"
      }
    });

    expect(env.cloudProvider).toBe("gcp");
    expect(env.cloudService).toBe("gcp");
    expect(env.marketplace).toBe("gcp");
    expect(env.region).toBe("us-central1");
  });

  it("does not override explicit provider aliases", () => {
    const env = buildExecutionEnv({
      baseEnv: {
        cloudProvider: "aws",
        cloudService: "aws",
        marketplace: "aws",
        region: "eu-west-1"
      },
      environment: "k8s-billing"
    });

    expect(env.cloudProvider).toBe("aws");
    expect(env.cloudService).toBe("aws");
    expect(env.marketplace).toBe("aws");
    expect(env.region).toBe("eu-west-1");
    expect(env.env).toBe("sm.k8s-billing.sm-qa.qa");
  });

  it("keeps qa.qa unchanged for runtime setup", () => {
    const env = buildExecutionEnv({
      baseEnv: {},
      environment: "qa.qa"
    });

    expect(env.env).toBe("qa.qa");
    expect(env.TUG_ENVIRONMENT).toBe("qa.qa");
  });
});
