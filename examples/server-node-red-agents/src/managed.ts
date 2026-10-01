import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { schemas } from "@agent-as-a-service/contract";

export type Definition = z.infer<typeof schemas.definition>;
export type Input = z.infer<typeof schemas.definitionInput> & {
  projectId?: string;
};
export type Node = Record<string, unknown> & {
  id: string;
  type: string;
  wires: string[][];
};
export type Tab = {
  id?: string;
  label: string;
  info: string;
  nodes: Node[];
  configs: Node[];
};
export type Registry = Record<string, { definition: Definition; tab: Tab }>;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);

/** Only declarative, installed nodes; no user-supplied JavaScript or HTTP endpoints. */
export function validate(input: Input): string[] {
  const errors: string[] = [];
  if (input.projectId) errors.push("Projects are not supported");
  if (input.engine !== "node-red") errors.push("engine must be node-red");
  if (input.specificationVersion !== "managed-v1")
    errors.push("specificationVersion must be managed-v1");
  const spec = input.specification;
  if (!object(spec))
    return [...errors, "specification must be a managed-v1 JSON object"];
  if (!keys(spec, ["label", "nodes", "configs", "entry", "finalizer"]))
    errors.push("Unknown specification field");
  if (
    typeof spec.label !== "string" ||
    !spec.label.trim() ||
    spec.label.length > 100
  )
    errors.push("label must be 1-100 characters");
  if (!Array.isArray(spec.configs) || spec.configs.length !== 0)
    errors.push("configs must be an empty array");
  if (!Array.isArray(spec.nodes) || !spec.nodes.length)
    return [...errors, "nodes must be a nonempty array"];
  const ids = new Set<string>();
  for (const value of spec.nodes) {
    if (
      !object(value) ||
      !identifier(value.id) ||
      ids.has(value.id) ||
      value.id.startsWith("aaas-")
    ) {
      errors.push("Node IDs must be unique, safe, and not reserved");
      continue;
    }
    ids.add(value.id);
    if (value.type !== "agent" || !keys(value, ["id", "type", "name", "wires"]))
      errors.push(`Unsupported node type or properties: ${value.id}`);
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 100
    )
      errors.push(`Invalid name: ${value.id}`);
    if (
      !Array.isArray(value.wires) ||
      value.wires.length !== 2 ||
      value.wires.some(
        (wire) => !Array.isArray(wire) || wire.some((id) => !identifier(id)),
      )
    )
      errors.push(`Invalid wires: ${value.id}`);
  }
  if (!identifier(spec.entry) || !ids.has(spec.entry))
    errors.push("entry must reference one node");
  if (!identifier(spec.finalizer) || !ids.has(spec.finalizer))
    errors.push("finalizer must reference one node");
  for (const value of spec.nodes) {
    if (!object(value) || !Array.isArray(value.wires)) continue;
    for (const wire of value.wires) {
      if (!Array.isArray(wire)) continue;
      for (const target of wire)
        if (!ids.has(target))
          errors.push(`Unknown wire target: ${String(target)}`);
    }
    if (
      value.id === spec.finalizer &&
      Array.isArray(value.wires[0]) &&
      value.wires[0].length
    )
      errors.push("finalizer must have no success outgoing wires");
  }
  return errors;
}

export function tabFor(input: Input, marker: string = randomUUID()): Tab {
  const spec = input.specification as {
    label: string;
    nodes: { id: string; name: string; wires: string[][] }[];
    entry: string;
    finalizer: string;
  };
  const prefix = `aaas-${marker}`;
  const nodes: Node[] = spec.nodes.map((node) => ({
    id: `${prefix}-${node.id}`,
    type: "agent",
    name: node.name,
    agent: "opencode",
    runtime: "direct",
    invocation: "prompt",
    model: "DEFAULT_MODEL",
    modelType: "env",
    prompt: "payload",
    promptType: "msg",
    timeout: "",
    timeoutType: "num",
    concurrency: 4,
    retryMaxAttempts: 2,
    auto: false,
    wires: [
      node.wires[0].map((id) => `${prefix}-${id}`),
      node.wires[1].map((id) => `${prefix}-${id}`),
    ],
  }));
  const final = nodes.find(
    (node) => node.id === `${prefix}-${spec.finalizer}`,
  )!;
  final.wires[0].push(`${prefix}-return`);
  for (const node of nodes) node.wires[1].push(`${prefix}-return`);
  nodes.push(
    {
      id: `${prefix}-in`,
      type: "link in",
      name: "Private invocation",
      links: [],
      wires: [[`${prefix}-entry`]],
    },
    {
      id: `${prefix}-entry`,
      type: "function",
      name: "managed-v1 text compatibility",
      func: `if (typeof msg.input?.text !== 'string' || !msg.input.text.trim()) { node.error('managed-v1 requires input.text', msg); return null; } msg.payload=msg.input.text; return msg;`,
      outputs: 1,
      wires: [[`${prefix}-${spec.entry}`]],
    },
    {
      id: `${prefix}-return`,
      type: "link out",
      name: "Return workflow result",
      mode: "return",
      links: [],
      wires: [],
    },
    {
      id: `${prefix}-catch`,
      type: "catch",
      name: "Catch failures",
      scope: [
        ...spec.nodes.map((node) => `${prefix}-${node.id}`),
        `${prefix}-entry`,
      ],
      uncaught: false,
      wires: [[`${prefix}-return`]],
    },
  );
  return {
    label: spec.label,
    info: `AaaS managed ${marker}`,
    nodes: nodes.map((node, index) => ({
      ...node,
      x: 180 + index * 180,
      y: 100,
      z: "managed-tab",
    })),
    configs: [],
  };
}

export const markerOf = (tab: Tab) =>
  /^AaaS managed ([a-f0-9-]{36})$/.exec(tab.info)?.[1];
export const entryOf = (tab: Tab) => `aaas-${markerOf(tab)}-in`;
