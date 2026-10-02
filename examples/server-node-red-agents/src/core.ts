import { readFileSync } from "node:fs";
import { schemas } from "@agent-as-a-service/contract";
import type { Definition } from "./native.js";

/** Server-owned definition; execution uses the ordinary native workflow snapshot. */
export const core: Definition = schemas.definition.parse({
  id: "core",
  name: "Core",
  engine: "node-red",
  version: 1,
  readOnly: true,
  createdAt: new Date().toISOString(),
  specification: {
    entry: "workflow-in",
    flows: JSON.parse(
      readFileSync(new URL("../node-red/flows.json", import.meta.url), "utf8"),
    ) as unknown,
  },
});
