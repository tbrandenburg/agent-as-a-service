import parser from "@typescript-eslint/parser";
import type { Linter } from "eslint";
import { complexity, exclude, sourceExclude, sources } from "./settings.js";

export default [
  { ignores: exclude },
  {
    files: sources,
    ignores: sourceExclude,
    languageOptions: { parser },
    rules: { complexity: ["warn", { max: complexity, variant: "classic" }] },
  },
] satisfies Linter.Config[];
