import {
  defineConfig,
  type TestProjectInlineConfiguration,
  type TestUserConfig,
} from "vitest/config";
import { createUiE2eVitestConfig } from "./vitest.ui-e2e.config.ts";

const proofFile = "ui/src/e2e/browser-passive-focus.pr-134480.proof.ts";

export function createPr134480UiE2eVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const base = createUiE2eVitestConfig(env, []);
  const template = base.test?.projects?.find(
    (candidate): candidate is TestProjectInlineConfiguration & { test: TestUserConfig } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "test" in candidate &&
      candidate.test?.name === "ui-e2e-serial-standalone",
  );
  if (!template) {
    throw new Error("PR 134480 proof requires the canonical standalone UI E2E project");
  }
  const globalSetup = [
    "test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts",
    ...[template.test.globalSetup ?? []].flat(),
  ];
  return defineConfig({
    ...base,
    cacheDir: ".artifacts/vite-ui-e2e-pr-134480",
    test: {
      ...base.test,
      include: [proofFile],
      projects: [
        {
          ...template,
          cacheDir: ".artifacts/vite-ui-e2e-pr-134480",
          test: {
            ...template.test,
            globalSetup,
            include: [proofFile],
            name: "ui-e2e-pr-134480",
          },
        },
      ],
    },
  });
}

export default createPr134480UiE2eVitestConfig();
