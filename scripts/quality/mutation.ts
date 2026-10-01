import { readFile } from "node:fs/promises";
import { z } from "zod";
import { baseline, directory } from "./settings.js";
import { empty, load, report, save } from "./report.js";

const parsed = z
  .object({
    files: z.record(
      z.object({
        mutants: z.array(
          z.object({
            testsCompleted: z.number().optional(),
            status: z.enum([
              "Killed",
              "Timeout",
              "Survived",
              "NoCoverage",
              "CompileError",
              "RuntimeError",
              "Ignored",
              "Pending",
            ]),
          }),
        ),
      }),
    ),
  })
  .parse(
    JSON.parse(await readFile(`${directory}/mutation/mutation.json`, "utf8")),
  );
const mutants = Object.values(parsed.files).flatMap((file) => file.mutants);
if (!mutants.length || mutants.some((mutant) => mutant.status === "Pending"))
  throw new Error("Empty or incomplete mutation result");
if (
  mutants.some(
    (mutant) => mutant.status === "Survived" && mutant.testsCompleted === 0,
  )
)
  throw new Error("Invalid mutation result: surviving mutants ran zero tests");
const detected = mutants.filter((mutant) =>
  ["Killed", "Timeout"].includes(mutant.status),
).length;
const undetected = mutants.filter((mutant) =>
  ["Survived", "NoCoverage"].includes(mutant.status),
).length;
if (!detected && !undetected) throw new Error("No valid measured mutants");
const current = empty();
current.mutation["managed.ts"] = (100 * detected) / (detected + undetected);
const counts = Object.fromEntries(
  [...new Set(mutants.map((mutant) => mutant.status))].map((status) => [
    status,
    mutants.filter((mutant) => mutant.status === status).length,
  ]),
);
console.log(
  `Mutation: ${mutants.length} mutants; ${JSON.stringify(counts)}; score ${current.mutation["managed.ts"].toFixed(2)}%`,
);
await report("mutation", current.mutation, await load(baseline));
await save(`${directory}/mutation.json`, current);
