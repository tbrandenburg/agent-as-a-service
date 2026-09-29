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
    model: "opencode/big-pickle",
    modelType: "str",
    cwd: "/data/agent-work",
    cwdType: "str",
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
  final.wires[0].push(`${prefix}-success`);
  for (const node of nodes) node.wires[1].push(`${prefix}-failure`);
  nodes.push(
    {
      id: `${prefix}-in`,
      type: "http in",
      name: "Private dispatch",
      url: `/managed/${marker}`,
      method: "post",
      wires: [[`${prefix}-entry`]],
    },
    {
      id: `${prefix}-entry`,
      type: "function",
      name: "Accept dispatch",
      func: `if (msg.req?.headers?.authorization !== 'Bearer '+env.get('INTERNAL_TOKEN')) { msg.statusCode=401; msg.payload={error:'Unauthorized'}; return [null,msg]; } const { runId, text } = msg.payload || {}; if (typeof runId !== 'string' || !runId || typeof text !== 'string' || !text.trim()) { msg.statusCode = 400; msg.payload = {error:'Invalid request'}; return [null,msg]; } const work = {runId, payload:text, agentObservation:{runId}}; msg.statusCode = 202; msg.payload = {accepted:true}; return [work,msg];`,
      outputs: 2,
      wires: [[`${prefix}-${spec.entry}`], [`${prefix}-response`]],
    },
    {
      id: `${prefix}-response`,
      type: "http response",
      name: "Dispatch response",
      wires: [],
    },
    {
      id: `${prefix}-success`,
      type: "function",
      name: "Finalize success",
      func: `if (msg.agentExecution?.status !== 'completed' || typeof msg.payload !== 'string' || !msg.payload.trim()) return [null,msg]; msg.payload = {runId:msg.runId,eventId:msg.runId+':completed',status:'completed',output:msg.payload}; return [msg,null];`,
      outputs: 2,
      wires: [[`${prefix}-headers`], [`${prefix}-failure`]],
    },
    {
      id: `${prefix}-catch`,
      type: "catch",
      name: "Catch failures",
      scope: spec.nodes.map((node) => `${prefix}-${node.id}`),
      uncaught: false,
      wires: [[`${prefix}-failure`]],
    },
    {
      id: `${prefix}-failure`,
      type: "function",
      name: "Finalize failure",
      func: `if (typeof msg.runId !== 'string' || !msg.runId) { node.warn('Uncorrelated failure'); return null; } msg.payload = {runId:msg.runId,eventId:msg.runId+':failed',status:'failed'}; return msg;`,
      outputs: 1,
      wires: [[`${prefix}-headers`]],
    },
    {
      id: `${prefix}-headers`,
      type: "function",
      name: "Private finalizer",
      func: `msg.method='POST'; msg.url='http://api:3095/finalize'; msg.headers={authorization:'Bearer '+env.get('INTERNAL_TOKEN'),'content-type':'application/json'}; return msg;`,
      outputs: 1,
      wires: [[`${prefix}-request`]],
    },
    {
      id: `${prefix}-request`,
      type: "http request",
      name: "Authenticated finalizer",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      wires: [[]],
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
export const entryOf = (tab: Tab) => `/managed/${markerOf(tab)}`;
