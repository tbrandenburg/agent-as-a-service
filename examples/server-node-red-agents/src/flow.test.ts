import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type FlowNode = {
  id: string;
  type: string;
  func?: string;
  wires: string[][];
  retryMaxAttempts?: number;
};
const nodes = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../node-red/flows.json", import.meta.url)),
    "utf8",
  ),
) as FlowNode[];
const node = (id: string) => {
  const result = nodes.find((item) => item.id === id);
  if (!result) throw new Error(`Missing flow node ${id}`);
  return result;
};
const invoke = (id: string, message: Record<string, unknown>) => {
  const func = node(id).func;
  if (!func) throw new Error(`Missing function ${id}`);
  return vm.runInNewContext(`(function(msg, env) { ${func} })(msg, env)`, {
    msg: message,
    env: { get: () => "internal-token" },
  }) as Record<string, unknown> | (Record<string, unknown> | null)[];
};

describe("deployed Node-RED flow guards", () => {
  it("wires one workflow input through two fixed nodes and an acknowledged checkpoint", () => {
    expect(
      nodes.filter((item) => item.type === "agent").map((item) => item.id),
    ).toEqual(["writer-agent", "reviewer-agent"]);
    expect(node("workflow-in").wires[0]).toEqual(["workflow-entry"]);
    expect(node("workflow-entry").wires[0]).toEqual(["writer-agent"]);
    expect(node("writer-agent").wires[0]).toEqual(["writer-result"]);
    expect(node("writer-result").wires[0]).toEqual(["checkpoint-request"]);
    expect(node("checkpoint-request").wires[0]).toEqual(["checkpoint-ack"]);
    expect(node("checkpoint-ack").wires[0]).toEqual(["reviewer-agent"]);
    expect(node("writer-agent").retryMaxAttempts).toBe(1);
    expect(node("reviewer-agent").retryMaxAttempts).toBe(1);
    expect(node("writer-in").wires[0]).toEqual(["writer-entry"]);
    expect(node("reviewer-in").wires[0]).toEqual(["reviewer-entry"]);
  });

  it("only confirmed writer results reach checkpoint and reviewer uses its own session", () => {
    const entry = invoke("workflow-entry", {
      payload: {
        runId: "r",
        text: "original",
        writerId: "w",
        reviewerId: "v",
        writerSession: "writer-old",
        reviewerSession: "reviewer-old",
        arbitrary: "ignored",
      },
    }) as (Record<string, unknown> | null)[];
    const writer = entry[0]!;
    expect(writer.sessionID).toBe("writer-old");
    expect(JSON.stringify(writer)).not.toContain("arbitrary");
    const failed = invoke("writer-result", {
      ...writer,
      payload: "text",
      sessionID: "writer-new",
      agentExecution: { status: "failed", resumed: true },
    }) as (Record<string, unknown> | null)[];
    expect(failed[0]).toBeNull();
    expect(failed[2]?.statusCode).toBe(502);
    const missingSession = invoke("writer-result", {
      ...writer,
      payload: "text",
      sessionID: undefined,
      agentExecution: { status: "completed", resumed: true },
    }) as (Record<string, unknown> | null)[];
    expect(missingSession[0]).toBeNull();
    const unconfirmed = invoke("writer-result", {
      ...writer,
      payload: "text",
      sessionID: "writer-new",
      agentExecution: { status: "completed", resumed: false },
    }) as (Record<string, unknown> | null)[];
    expect(unconfirmed[0]).toBeNull();
    const passed = invoke("writer-result", {
      ...writer,
      payload: "writer reply",
      sessionID: "writer-new",
      agentExecution: { status: "completed", resumed: true },
    }) as (Record<string, unknown> | null)[];
    const checkpoint = passed[0]!;
    expect(checkpoint.payload).toMatchObject({
      runId: "r",
      conversationId: "w",
      reply: "writer reply",
      sessionID: "writer-new",
    });
    expect(JSON.stringify(checkpoint.payload)).toContain("original");
    const rejected = invoke("checkpoint-ack", {
      ...checkpoint,
      statusCode: 409,
      payload: { acknowledged: false },
    }) as (Record<string, unknown> | null)[];
    expect(rejected[0]).toBeNull();
    const reviewer = invoke("checkpoint-ack", {
      ...checkpoint,
      statusCode: 200,
      payload: { acknowledged: true },
    }) as (Record<string, unknown> | null)[];
    expect(reviewer[0]?.sessionID).toBe("reviewer-old");
    expect(reviewer[0]?.payload).toContain("writer reply");
    const reviewerFailed = invoke("reviewer-result", {
      ...reviewer[0],
      payload: null,
      sessionID: "reviewer-new",
      agentExecution: { status: "timeout", resumed: true },
    }) as Record<string, unknown>;
    expect(reviewerFailed.statusCode).toBe(502);
  });
});
