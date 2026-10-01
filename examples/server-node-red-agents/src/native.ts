import type { z } from "zod";
import { schemas } from "@agent-as-a-service/contract";

export type Definition = z.infer<typeof schemas.definition>;
export type Input = z.infer<typeof schemas.definitionInput>;
export type Specification = { entry: string; flows: Record<string, unknown>[] };
export type Registry = Record<string, Definition>;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Node-RED owns node properties, graph semantics and installed-node availability. */
export function validate(input: Input): string[] {
  const errors = input.engine === "node-red" ? [] : ["engine must be node-red"];
  const spec = input.specification;
  if (!object(spec)) return [...errors, "specification must be an object"];
  if (typeof spec.entry !== "string" || !spec.entry.trim())
    errors.push("entry must be a nonempty string");
  if (
    !Array.isArray(spec.flows) ||
    !spec.flows.length ||
    !spec.flows.every(object)
  )
    return [...errors, "flows must be a nonempty array of objects"];
  const entries = spec.flows.filter((node) => node.id === spec.entry);
  if (entries.length !== 1 || entries[0].type !== "link in")
    errors.push("entry must reference exactly one Link In");
  return errors;
}

export const snapshot = (definition: Definition): Specification =>
  structuredClone(definition.specification as Specification);
