import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import { baseline, directory } from "./settings.js";
import { empty, load, report, save } from "./report.js";

const coverage = process.argv.includes("--coverage");
const path = `${directory}/${coverage ? "coverage-tests" : "tests"}.json`;
await mkdir(directory, { recursive: true });
await rm(path, { force: true });
const start = performance.now();
const args = coverage
  ? ["--config", "scripts/quality/vitest.coverage.ts", "--coverage"]
  : process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    ...args,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${path}`,
  ],
  { stdio: "inherit", timeout: 180_000 },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const parsed = z
  .object({
    numTotalTests: z.number().positive(),
    numFailedTests: z.literal(0),
    testResults: z
      .array(
        z.object({
          name: z.string(),
          startTime: z.number(),
          endTime: z.number(),
        }),
      )
      .nonempty(),
  })
  .parse(JSON.parse(await readFile(path, "utf8")));
const current = empty();
current.runtime[coverage ? "coverage-suite-ms" : "suite-ms"] =
  performance.now() - start;
for (const file of parsed.testResults)
  current.runtime[
    `${coverage ? "coverage:" : ""}${relative(process.cwd(), file.name)}`
  ] = file.endTime - file.startTime;
const previous = await load(baseline);
await report("runtime", current.runtime, previous);
// Preserve both ordinary and coverage runtimes for the explicit ratchet command.
const runtimePath = `${directory}/runtime.json`;
const saved = await load(runtimePath).catch((error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
    return empty();
  throw error;
});
await save(runtimePath, {
  ...current,
  runtime: {
    ...Object.fromEntries(
      Object.entries(saved.runtime).filter(([key]) =>
        coverage ? !key.startsWith("coverage") : key.startsWith("coverage"),
      ),
    ),
    ...current.runtime,
  },
});
if (coverage) {
  const summary = z
    .record(
      z.object({
        branches: z.object({
          pct: z.number().finite(),
          total: z.number().nonnegative(),
          covered: z.number().nonnegative(),
        }),
      }),
    )
    .parse(
      JSON.parse(
        await readFile(`${directory}/coverage/coverage-summary.json`, "utf8"),
      ),
    );
  for (const [path, value] of Object.entries(summary))
    current.coverage[path === "total" ? path : relative(process.cwd(), path)] =
      value.branches.pct;
  if (!Object.keys(current.coverage).length)
    throw new Error("Empty coverage report");
  await report("coverage", current.coverage, previous);
  await save(`${directory}/coverage.json`, current);
}
