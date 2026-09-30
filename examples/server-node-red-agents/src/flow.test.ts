import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type FlowNode = {
  id: string;
  type: string;
  func?: string;
  wires: string[][];
  concurrency?: number;
  model?: string;
  modelType?: string;
};
const nodes = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../node-red/flows.json", import.meta.url)),
    "utf8",
  ),
) as FlowNode[];
const node = (id: string) => {
  const result = nodes.find((item) => item.id === id);
  if (!result) throw new Error(`Missing ${id}`);
  return result;
};
const invoke = (id: string, message: Record<string, unknown>) =>
  vm.runInNewContext(
    `(function(msg, node, env) { ${node(id).func} })(msg, node, env)`,
    {
      msg: message,
      node: { error: () => {}, warn: () => {} },
      env: { get: () => "internal-test-token" },
    },
  ) as Record<string, unknown> | (Record<string, unknown> | null)[] | null;

describe("deployed flow boundary", () => {
  it("resolves the operator model for both Core agents", () => {
    for (const id of ["writer-agent", "reviewer-agent"])
      expect(node(id)).toMatchObject({
        model: "DEFAULT_MODEL",
        modelType: "env",
      });
  });
  it("dispatches before agents and propagates correlation through parallel join and repeated node", () => {
    expect(node("workflow-entry").wires).toEqual([
      ["writer-agent"],
      ["reviewer-agent"],
      ["response"],
    ]);
    expect(node("writer-agent").concurrency).toBeGreaterThan(1);
    const [writer, reviewer, response] = invoke("workflow-entry", {
      req: { headers: { authorization: "Bearer internal-test-token" } },
      payload: { runId: "r1", text: "input", arbitrary: "secret" },
    }) as Record<string, unknown>[];
    expect(response.statusCode).toBe(202);
    expect(writer.agentObservation).toEqual({ runId: "r1" });
    expect(reviewer.agentObservation).toEqual({ runId: "r1" });
    expect(JSON.stringify(writer)).not.toContain("secret");
    const [branch] = invoke("branch-result", {
      ...writer,
      payload: "real output",
      agentExecution: { status: "completed" },
    }) as Record<string, unknown>[];
    expect(branch.parts).toMatchObject({ id: "r1", count: 2 });
    const [summary] = invoke("summary-prompt", {
      ...branch,
      payload: ["real output", "test suggestion"],
    }) as Record<string, unknown>[];
    expect(node("summary-prompt").wires[0]).toEqual(["writer-agent"]);
    expect(summary.agentObservation).toEqual({ runId: "r1" });
    expect(summary.parts).toBeUndefined();
    expect(summary.topic).toBe("summary");
    const [final] = invoke("success", {
      ...summary,
      payload: "final reply",
      agentExecution: { status: "completed" },
    }) as Record<string, unknown>[];
    expect(final).toMatchObject({
      payload: { runId: "r1", status: "completed", output: "final reply" },
    });
    const [, summarized] = invoke("branch-result", {
      ...summary,
      payload: "final reply",
      agentExecution: { status: "completed" },
    }) as (Record<string, unknown> | null)[];
    expect(summarized?.payload).toBe("final reply");
    expect(invoke("failure", { runId: "r1" })).toMatchObject({
      payload: { runId: "r1", status: "failed" },
    });
    expect(node("agent-catch").wires).toEqual([["failure"]]);
    expect(
      (invoke("final-headers", final) as Record<string, unknown>).headers,
    ).toMatchObject({ authorization: "Bearer internal-test-token" });
  });
});
