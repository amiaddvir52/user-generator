import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { buildEnvironmentCatalog } from "./environment-catalog.js";

const tempRoots: string[] = [];

const createTempDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "user-generator-envs-"));
  tempRoots.push(directory);
  return directory;
};

const writeFile = async (root: string, relativePath: string, contents: string) => {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
};

const createFixtureRepo = async () => {
  const directory = await createTempDir();
  await fs.mkdir(path.join(directory, ".git"));

  await writeFile(
    directory,
    "e2e-automation/sm-ui-refresh/types/environments.ts",
    `export enum Environments {
  QA = 'qa.qa',
  STAGING = 'staging.qa',
  DEV = 'sm.k8s-dev.sm-qa.qa',
  DEV_UI_REFRESH = 'sm.k8s-dev-uirefresh.sm-qa.qa',
  AA = 'sm.k8s-aa.sm-qa.qa',
  BILLING = 'sm.k8s-billing.sm-qa.qa',
  CLOUDAPI = 'sm.k8s-cloudapi.sm-qa.qa',
  GCP = 'sm.k8s-gcp.sm-qa.qa',
  IDM = 'sm.k8s-idm.sm-qa.qa',
  INTEGRATION = 'sm.k8s-integration.sm-qa.qa',
  MW = 'sm.k8s-mw.sm-qa.qa',
  PSC = 'sm.k8s-psc.sm-qa.qa',
  RCP = 'sm.k8s-rcp.sm-qa.qa'
}
`
  );

  await writeFile(
    directory,
    "e2e-automation/sm-ui-refresh/playwright-helpers/environment.ts",
    `const k8sDomains = {
  'qa.qa': 'sm.k8s-dev-uirefresh.sm-qa.qa',
  'aa.qa': 'sm.k8s-aa.sm-qa.qa',
  gcp: 'sm.k8s-gcp.sm-qa.qa'
};
`
  );

  await writeFile(
    directory,
    "packages/api-clients/http-client.ts",
    `const k8sDomains = {
  'cloudapi.qa': 'sm.k8s-cloudapi.sm-qa.qa'
};
`
  );

  await writeFile(
    directory,
    "packages/api-clients/http-clients/sm-envs-client.ts",
    `const envList = ['integration.qa', 'qa.qa', 'staging.qa'];
if (env === 'cloudapi.qa') {
  return env;
}
`
  );

  await writeFile(
    directory,
    "microservices/feature-flags/src/features/get-envs.ts",
    `export const getEnvs = () => {
  const envs: string[] = [];
  envs.push('aa.qa');
  return envs;
};
`
  );

  await writeFile(
    directory,
    "e2e-automation/sm-ui-refresh/continuous-integration/sm-core/core.groovy",
    `choice(
  name: 'env',
  choices: ['sm.k8s-auto.sm-qa.qa', 'sm.k8s-billing-dev.sm-qa.qa', 'sm.k8s-gh.sm-qa.qa'].join('\\n')
)
`
  );

  await writeFile(
    directory,
    "e2e-automation/sm-ui-refresh/continuous-integration/nashville/nashville.groovy",
    `editableChoice(
  name: 'environments',
  choices: ['sm.sm-poc.sm-qa.qa'].join('\\n')
)
`
  );

  return directory;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("buildEnvironmentCatalog", () => {
  it("collects environment definitions from repo sources with provenance and warnings", async () => {
    const repoDir = await createFixtureRepo();

    const result = await buildEnvironmentCatalog(repoDir);

    expect(result.environments.map((environment) => environment.value)).toEqual([
      "k8s-integration",
      "k8s-billing",
      "k8s-billing-dev",
      "auto",
      "qa.qa",
    ]);

    expect(result.environments.find((environment) => environment.value === "qa.qa")).toMatchObject({
      category: "alias",
      normalizedValue: "sm.k8s-dev-uirefresh.sm-qa.qa",
      warnings: expect.arrayContaining([
        "Helper alias resolves to sm.k8s-dev-uirefresh.sm-qa.qa.",
        "Variant also defined as sm.k8s-dev-uirefresh.sm-qa.qa."
      ])
    });

    expect(
      result.environments.find((environment) => environment.value === "auto")
    ).toMatchObject({
      category: "alias",
      normalizedValue: "sm.k8s-auto.sm-qa.qa"
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "CI-only environments were discovered outside the typed enum: sm.k8s-auto.sm-qa.qa, sm.k8s-billing-dev.sm-qa.qa, sm.k8s-gh.sm-qa.qa, sm.sm-poc.sm-qa.qa",
        "Environment variants are defined in multiple forms: aa.qa, sm.k8s-aa.sm-qa.qa",
        "Environment variants are defined in multiple forms: cloudapi.qa, sm.k8s-cloudapi.sm-qa.qa",
        "Environment variants are defined in multiple forms: gcp, sm.k8s-gcp.sm-qa.qa",
        "Environment variants are defined in multiple forms: qa.qa, sm.k8s-dev-uirefresh.sm-qa.qa"
      ])
    );
  });
});
