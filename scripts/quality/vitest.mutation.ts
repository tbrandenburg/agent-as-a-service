import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["examples/server-node-red-agents/src/managed.test.ts"],
    exclude: [".worktrees/**", "data/**", "**/node_modules/**"],
    maxWorkers: 1,
  },
});
