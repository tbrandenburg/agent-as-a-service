import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.js";
import {
  directory,
  exclude,
  sourceExclude,
  scope,
  sources,
} from "./settings.js";

export default mergeConfig(
  { ...base, test: { ...base.test, include: [`${scope}/src/**/*.test.ts`] } },
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: sources,
        exclude: [...exclude, ...sourceExclude],
        reportsDirectory: `${directory}/coverage`,
        reporter: ["text", "json-summary", "html"],
      },
    },
  }),
);
