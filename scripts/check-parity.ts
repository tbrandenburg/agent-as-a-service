import { readFileSync } from "node:fs";
import { contract } from "../packages/contract/src/index.js";
const signatures = JSON.parse(
  readFileSync(new URL("./archon-rest-routes.json", import.meta.url), "utf8"),
) as string[];
const map = JSON.parse(
  readFileSync(new URL("./rest-parity-map.json", import.meta.url), "utf8"),
) as Record<string, string>;
const names = new Set<string>();
function walk(tree: Record<string, unknown>) {
  for (const [name, value] of Object.entries(tree)) {
    if (value && typeof value === "object" && "method" in value)
      names.add(name);
    else walk(value as Record<string, unknown>);
  }
}
walk(contract as unknown as Record<string, unknown>);
const missing = signatures.filter((s) => !map[s]);
const stale = Object.keys(map).filter((s) => !signatures.includes(s));
const unresolved = Object.values(map)
  .filter((s) => !s.startsWith("EXCLUDED: "))
  .flatMap((s) => s.split(" / "))
  .filter((s) => !names.has(s));
if (missing.length || stale.length || unresolved.length)
  throw new Error(JSON.stringify({ missing, stale, unresolved }));
console.log(
  `${signatures.length} source REST routes accounted for (${Object.values(map).filter((s) => s.startsWith("EXCLUDED: ")).length} deliberate exclusions)`,
);
