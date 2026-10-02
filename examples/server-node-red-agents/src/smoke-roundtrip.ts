import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "../../client/src/index.js";
import { echo } from "./native-fixtures.js";

export async function smokeRoundtrip(
  base: string,
  token: string,
  signal: AbortSignal,
  measure: <T>(phase: string, work: () => Promise<T>) => Promise<T>,
) {
  const api = createClient(base, token);
  const options = () => ({
    fetchOptions: {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    },
  });
  const definition = {
    ...echo("msg.payload=msg.input.a*msg.input.b;return msg;"),
    name: "Smoke multiplication",
  };
  const valid = await measure("workflowValidationMs", () =>
    api.workflows.validateWorkflow({ body: definition, ...options() }),
  );
  assert.equal(valid.status, 200, "workflow validation HTTP status");
  if (valid.status !== 200) throw new Error("Workflow validation rejected");
  assert.equal(valid.body.valid, true);

  const created = await measure("workflowCreationMs", () =>
    api.workflows.createWorkflow({ body: definition, ...options() }),
  );
  assert.equal(created.status, 201, "workflow creation HTTP status");
  if (created.status !== 201) throw new Error("Workflow creation rejected");
  assert.equal(created.headers.get("etag"), '"v1"');
  assert.equal(created.body.version, 1);
  const workflowId = created.body.id;
  const stored = await measure("workflowRetrievalMs", () =>
    api.workflows.getWorkflow({ params: { workflowId }, ...options() }),
  );
  assert.equal(stored.status, 200, "workflow retrieval HTTP status");
  if (stored.status !== 200) throw new Error("Workflow retrieval rejected");
  assert.deepEqual(stored.body.specification, definition.specification);

  const input = { a: 13.75, b: -8 };
  return measure("executionMs", async () => {
    const accepted = await measure("runAcceptanceMs", () =>
      api.runs.startRun({
        headers: { "idempotency-key": randomUUID() },
        body: { target: { kind: "workflow", workflowId }, input },
        ...options(),
      }),
    );
    assert.equal(accepted.status, 202, "run acceptance HTTP status");
    if (accepted.status !== 202) throw new Error("Run rejected");
    const runId = accepted.body.run.id;
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      const detail = await api.runs.getRun({ params: { runId }, ...options() });
      assert.equal(detail.status, 200, "accepted run must be readable");
      if (detail.status !== 200) throw new Error("Run retrieval rejected");
      const run = detail.body.run;
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        assert.equal(run.status, "completed", `Run error: ${run.error?.code}`);
        assert.equal(run.workflowVersion, 1);
        assert.deepEqual(run.input, input);
        assert.equal(typeof run.output, "number");
        assert.equal(run.output, -110);
        console.log(
          `WORKING: ${input.a} × ${input.b} = ${run.output} (HTTP 201/202/200)`,
        );
        return { workflowId, runId, input, output: run.output };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      signal.throwIfAborted();
    }
    throw new Error(`Run ${runId} did not finish within 60 seconds`);
  });
}
