import { describe, expect, it } from "vitest";

import { buildProviderCatalog } from "./provider-catalog.js";

describe("buildProviderCatalog", () => {
  it("prefers the direct Augment SDK when both Augment backends are available", async () => {
    const result = await buildProviderCatalog({
      env: {
        PATH: "/bin",
        AUGMENT_API_TOKEN: "token"
      },
      commandResolver: async (command) => {
        if (command === "auggie") {
          return "/bin/auggie";
        }

        if (command === "codex") {
          return "/bin/codex";
        }

        return undefined;
      }
    });

    expect(result.providers.find((provider) => provider.id === "augment")).toMatchObject({
      available: true,
      availableBackends: ["augment-sdk", "augment-auggie"],
      defaultBackend: "augment-sdk"
    });
  });

  it("falls back to the auggie backend when direct Augment credentials are unavailable", async () => {
    const result = await buildProviderCatalog({
      env: {
        PATH: "/bin"
      },
      commandResolver: async (command) => {
        if (command === "auggie") {
          return "/bin/auggie";
        }

        return undefined;
      }
    });

    expect(result.providers.find((provider) => provider.id === "augment")).toMatchObject({
      available: true,
      availableBackends: ["augment-auggie"],
      defaultBackend: "augment-auggie",
      warnings: expect.arrayContaining([
        "Direct Augment SDK is unavailable because AUGMENT_API_TOKEN is not set.",
        "Augment will fall back to the local auggie backend."
      ])
    });
  });

  it("keeps Cursor unavailable even when a Cursor executable is detected", async () => {
    const result = await buildProviderCatalog({
      env: {
        PATH: "/bin"
      },
      commandResolver: async (command) => {
        if (command === "cursor-agent") {
          return "/bin/cursor-agent";
        }

        return undefined;
      }
    });

    expect(result.providers.find((provider) => provider.id === "cursor")).toMatchObject({
      available: false,
      availableBackends: [],
      reason:
        "Cursor is intentionally disabled until user-generator has a concrete Cursor execution backend."
    });
  });
});
