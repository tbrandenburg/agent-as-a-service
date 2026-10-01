export const scope = "examples/server-node-red-agents";
export const sources = [`${scope}/src/*.ts`, `${scope}/node-red/**/*.js`];
export const tests = [
  `${scope}/src/**/*.test.ts`,
  `${scope}/node-red/**/*.test.cjs`,
];
export const exclude = ["**/node_modules/**", "**/.worktrees/**", "data/**"];
export const sourceExclude = [
  `${scope}/src/*.test.ts`,
  `${scope}/src/*-demo.ts`,
  `${scope}/src/demo.ts`,
];
export const directory = "data/quality";
export const baseline = "scripts/quality/baseline.json";
export const complexity = 10;
