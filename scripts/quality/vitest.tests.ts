import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/quality/**/*.test.ts"],
    exclude: [".worktrees/**", "data/**", "**/node_modules/**"],
    maxWorkers: 1,
  },
});
