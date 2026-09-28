import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "examples/**/*.test.ts"],
    exclude: [".worktrees/**"],
    pool: "forks",
    maxWorkers: 1,
  },
});
