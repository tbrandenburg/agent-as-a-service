import { mkdir } from "node:fs/promises";
import { structure } from "./collect.js";
import { baseline, directory } from "./settings.js";
import { empty, load, ratchet, report, save } from "./report.js";

const updating = process.argv.includes("--baseline");
const previous = await load(baseline);
const current = { ...empty(), ...(await structure()) };
for (const metric of ["sizes", "ratios", "complexity"] as const)
  await report(metric, current[metric], previous);
await mkdir(directory, { recursive: true });
await save(`${directory}/structure.json`, current);
if (updating) {
  const runtime = await load(`${directory}/runtime.json`);
  const coverage = await load(`${directory}/coverage.json`);
  const mutation = await load(`${directory}/mutation.json`);
  const measured = {
    ...current,
    runtime: runtime.runtime,
    coverage: coverage.coverage,
    mutation: mutation.mutation,
  };
  await save(baseline, ratchet(measured, previous));
  console.log(
    "Baseline tightened; review and commit scripts/quality/baseline.json. Regressions were not accepted.",
  );
}
