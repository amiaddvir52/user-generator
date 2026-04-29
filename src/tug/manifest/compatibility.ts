export type CompatibilityManifest = {
  toolVersion: string;
  fingerprints: Record<
    string,
    {
      status: "supported";
      firstSeenDate: string;
      notes?: string;
      teardownIdentifiers: string[];
    }
  >;
};

export const compatibilityManifest: CompatibilityManifest = {
  toolVersion: "0.1.0",
  fingerprints: {}
};

