import { appendFile, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const measurements = z.record(z.number().finite().nonnegative());
export const snapshot = z.object({
  sizes: measurements,
  ratios: measurements,
  complexity: measurements,
  runtime: measurements,
  coverage: measurements,
  mutation: measurements,
});
export type Snapshot = z.infer<typeof snapshot>;
export type Metric = keyof Snapshot;
export const empty = (): Snapshot =>
  snapshot.parse({
    sizes: {},
    ratios: {},
    complexity: {},
    runtime: {},
    coverage: {},
    mutation: {},
  });
export async function load(path: string): Promise<Snapshot> {
  return snapshot.parse(JSON.parse(await readFile(path, "utf8")));
}
export async function save(path: string, value: Snapshot) {
  const sorted = Object.fromEntries(
    Object.entries(value).map(([metric, values]) => [
      metric,
      Object.fromEntries(
        Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ]),
  );
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
}
const higher = (metric: Metric) =>
  metric === "coverage" || metric === "mutation";
export function regressions(
  metric: Metric,
  current: Record<string, number>,
  previous: Record<string, number>,
): string[] {
  return Object.entries(current).flatMap(([key, value]) => {
    const old = previous[key];
    if (old === undefined)
      return [
        `${metric} ${key}: ${value.toFixed(2)} (new measurement; review baseline)`,
      ];
    // Runtime needs headroom for machine/load variance, rather than noisy millisecond warnings.
    const limit = metric === "runtime" ? old * 1.5 + 250 : old;
    const regressed = higher(metric) ? value < limit : value > limit;
    return regressed
      ? [
          `${metric} ${key}: ${value.toFixed(2)} regressed from ${old.toFixed(2)}${metric === "runtime" ? " (50% + 250ms headroom)" : ""}`,
        ]
      : [];
  });
}
export function ratchet(current: Snapshot, previous: Snapshot): Snapshot {
  return snapshot.parse(
    Object.fromEntries(
      Object.entries(current).map(([name, values]) => {
        const metric = name as Metric;
        return [
          metric,
          Object.fromEntries(
            Object.entries(values).map(([key, value]) => {
              const old = previous[metric][key];
              return [
                key,
                old === undefined
                  ? value
                  : higher(metric)
                    ? Math.max(old, value)
                    : Math.min(old, value),
              ];
            }),
          ),
        ];
      }),
    ),
  );
}
export async function report(
  metric: Metric,
  current: Record<string, number>,
  previous: Snapshot,
) {
  const warnings = regressions(metric, current, previous[metric]);
  const heading = `${metric}: ${Object.keys(current).length} measurements, ${warnings.length} regression/new-baseline warnings`;
  console.log(heading);
  for (const warning of warnings)
    console.log(
      `::warning title=Quality drift::${warning.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${heading}\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n`,
    );
}
