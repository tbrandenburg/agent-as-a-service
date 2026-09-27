import { readFileSync, writeFileSync } from "node:fs";
const routes = JSON.parse(
  readFileSync(new URL("./archon-rest-routes.json", import.meta.url), "utf8"),
) as string[];
const map = JSON.parse(
  readFileSync(new URL("./rest-parity-map.json", import.meta.url), "utf8"),
) as Record<string, string>;
const lines = [
  "# Archon REST parity map",
  "",
  "Source snapshot: Archon `dev` commit `879c99fe4dceeeae1bef98869e9427f38aadeea4`. This table maps **capabilities**, not identical wire formats. `EXCLUDED` rows record deliberate source-specific omissions. Every named operation is defined in the independent versioned TypeScript contract. The example server responds `501` for resource operations; health, authenticated status and OpenAPI return `200`.",
  "",
  "| Archon HTTP route | Independent operation |",
  "| --- | --- |",
];
for (const source of routes)
  lines.push(`| \`${source}\` | \`${map[source]}\` |`);
lines.push(
  "",
  "## Core scope",
  "",
  "This snapshot accounts for all 65 Archon REST routes; `EXCLUDED` means intentionally outside the small, stable REST core, not an implementation claim. Workflow discovery maps to listing definitions. Archon-specific admin, provider, OAuth, environment, webhook and dashboard-wide streaming features can be added later when the server and use case require them. Conversation streaming has a separate core operation.",
  "",
  "Archon codebases map to optional, more general projects; their repository URL is optional. Projects, conversations, workflows and runs remain independent resources. Run details expose optional executions and interactions without prescribing an engine node schema. Poll or stream ordered run events for progress; terminal output or error is available from the run. Server-provided workflows appear in the existing list with `readOnly: true`. A project may optionally identify a server-side local path.",
  "",
);
writeFileSync(
  new URL("../docs/rest-parity.md", import.meta.url),
  lines.join("\n"),
);
console.log(`${routes.length} source routes accounted for`);
