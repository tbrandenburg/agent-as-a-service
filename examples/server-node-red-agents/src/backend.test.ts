import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend } from "./backend.js";
import type { Executor } from "./backend.js";

const auth = { authorization: "Bearer test-token" };
const start = (text = "Release notes") => ({
  target: { kind: "workflow", workflowId: "node-red-demo" },
  input: { text },
});
const node = (
  type: string,
  nodeId = "writer-agent",
  deploymentId = "generation-1",
) => ({
  version: 1,
  type,
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  nodeId,
  deploymentId,
  agent: "opencode",
  agentName: "Writer",
});
const started = (
  runId: string,
  executionId = randomUUID(),
  nodeId = "writer-agent",
) => ({
  ...node("execution.started", nodeId),
  executionId,
  agentObservation: { runId },
  input: { invocation: "prompt", prompt: "Resolved input" },
});
const terminal = (
  startRecord: ReturnType<typeof started>,
  status = "completed",
) => ({
  ...startRecord,
  type: "execution.terminal",
  eventId: randomUUID(),
  status,
  output: { payload: "Real reply" },
});
const done = (runId: string, status = "completed") => ({
  runId,
  status,
  eventId: randomUUID(),
  output: "Final result",
});
const setup = (dispatch: Executor = async () => {}) => {
  const backend = new AgentsBackend(dispatch);
  const app = createApp({
    token: "test-token",
    implementation: backend.implementation(),
  });
  return { backend, app };
};
const run = async (app: ReturnType<typeof setup>["app"], text?: string) => {
  const response = await request(app)
    .post("/api/v1/runs")
    .set(auth)
    .send(start(text));
  expect(response.status).toBe(202);
  return response.body.run.id as string;
};

describe("Node-RED lifecycle boundary", () => {
  it("transports contract workflow inputs unchanged and completes non-agent outputs", async () => {
    const inputs = [
      "literal",
      {
        repository: "acme/app",
        limit: 3,
        enabled: true,
        nested: { flags: [false, 2] },
      },
      [{ type: "text", text: "part" }],
    ];
    for (const input of inputs) {
      const dispatched: Parameters<Executor>[0][] = [];
      const { backend, app } = setup(async (payload) => {
        dispatched.push(payload);
      });
      const accepted = await request(app)
        .post("/api/v1/runs")
        .set(auth)
        .send({ ...start(), input });
      expect(accepted.status).toBe(202);
      const id = accepted.body.run.id as string;
      await new Promise((resolve) => setImmediate(resolve));
      expect(dispatched[0]).toMatchObject({
        runId: id,
        input,
        target: "workflow-in",
      });
      expect(dispatched[0].text).toBeUndefined();
      expect(backend.runs.get(id)?.run.input).toEqual(input);
      const output = [{ type: "data", data: { accepted: true } }];
      expect(backend.finalize({ ...done(id), output: {} }).status).toBe(400);
      expect(backend.finalize({ ...done(id), output }).status).toBe(200);
      expect(backend.runs.get(id)?.run.output).toEqual(output);
    }
  });
  it("keeps direct agent input text-only", async () => {
    const { app } = setup();
    for (const input of [
      "literal",
      { text: "prompt", extra: true },
      [{ type: "text", text: "part" }],
    ])
      expect(
        (
          await request(app)
            .post("/api/v1/runs")
            .set(auth)
            .send({ target: { kind: "agent", agentId: "writer-agent" }, input })
        ).status,
      ).toBe(400);
  });
  it("stores ordered idempotent node observations separately from provider conversations and finalizer status", async () => {
    const { backend, app } = setup();
    const id = await run(app);
    const batch = {
      runId: id,
      observations: [
        { sequence: 1, type: "sent", nodeId: "source" },
        {
          sequence: 2,
          type: "received",
          nodeId: "writer",
          executionId: "invocation-1",
          status: "running",
        },
        {
          sequence: 3,
          type: "received",
          nodeId: "writer",
          executionId: "invocation-2",
          status: "running",
        },
        {
          sequence: 4,
          type: "completed",
          nodeId: "writer",
          executionId: "invocation-2",
          status: "failed",
        },
        {
          sequence: 5,
          type: "completed",
          nodeId: "writer",
          executionId: "invocation-1",
          status: "completed",
        },
        {
          sequence: 6,
          type: "received",
          nodeId: "legacy",
          executionId: "invocation-3",
          status: "running",
        },
      ],
    };
    expect(backend.observeNodes(batch).status).toBe(200);
    expect(backend.observeNodes(batch).status).toBe(200);
    expect(
      backend.observeNodes({
        ...batch,
        observations: [{ ...batch.observations[0], nodeId: "other" }],
      }).status,
    ).toBe(409);
    expect(
      backend.observeNodes({
        runId: id,
        observations: [{ sequence: 8, type: "sent", nodeId: "x" }],
      }).status,
    ).toBe(409);
    expect(
      backend.observeNodes({
        runId: id,
        observations: [
          {
            sequence: 7,
            type: "completed",
            nodeId: "wrong",
            executionId: "invocation-3",
            status: "completed",
          },
        ],
      }).status,
    ).toBe(409);
    expect(
      backend.observeNodes({
        runId: id,
        observations: [
          {
            sequence: 7,
            type: "completed",
            nodeId: "legacy",
            executionId: "invocation-2",
            status: "completed",
          },
        ],
      }).status,
    ).toBe(409);
    expect(backend.drainNodes({ runId: id }).status).toBe(200);
    expect(backend.runs.get(id)?.run.status).toBe("running");
    const snapshot = await request(app).get(`/api/v1/runs/${id}`).set(auth);
    expect(snapshot.body.executions).toEqual([
      { id: "invocation-1", runId: id, key: "writer", status: "completed" },
      { id: "invocation-2", runId: id, key: "writer", status: "failed" },
      { id: "invocation-3", runId: id, key: "legacy", status: "unconfirmed" },
    ]);
    expect(snapshot.body.conversations).toEqual([]);
    const agent = started(id);
    expect(backend.observe(agent).status).toBe(200);
    expect(backend.observe(terminal(agent)).status).toBe(200);
    expect(backend.finalize(done(id)).status).toBe(200);
    expect(backend.runs.get(id)?.run.status).toBe("completed");
    expect(backend.runs.get(id)?.executions?.[1].status).toBe("failed");
    expect(backend.events.get(id)?.map((event) => event.sequence)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(
      backend.observeNodes({
        runId: id,
        observations: [{ sequence: 7, type: "sent", nodeId: "late" }],
      }).status,
    ).toBe(409);
  });

  it("keeps worker crash and callback interruption visible without changing a finalized run", async () => {
    const { backend, app } = setup();
    const id = await run(app);
    expect(
      backend.observeNodes({
        runId: id,
        observations: [
          {
            sequence: 1,
            type: "received",
            nodeId: "async",
            executionId: "a",
            status: "running",
          },
        ],
      }).status,
    ).toBe(200);
    backend.workerFailed(id);
    expect(backend.runs.get(id)?.executions?.[0].status).toBe("unconfirmed");
    expect(backend.runs.get(id)?.run.error?.code).toBe("worker_failed");
    expect(
      backend.events
        .get(id)
        ?.some((event) => event.type === "observation.incomplete"),
    ).toBe(true);
  });

  it("preserves callback interruption reason and replayed observations across shutdown", async () => {
    const { backend, app } = setup();
    const id = await run(app);
    const batch = {
      runId: id,
      observations: [
        {
          sequence: 1,
          type: "received",
          nodeId: "writer",
          executionId: "first",
          status: "running",
        },
      ],
    };
    expect(backend.observeNodes(batch).status).toBe(200);
    expect(
      backend.observeNodes({
        runId: id,
        observations: [
          {
            sequence: 2,
            type: "completed",
            nodeId: "writer",
            executionId: "first",
            status: "completed",
          },
        ],
      }).status,
    ).toBe(200);
    expect(backend.observeNodes(batch).status).toBe(200);
    expect(
      backend.drainNodes({ runId: id, incomplete: "callback_failed" }).status,
    ).toBe(200);
    expect(
      backend.drainNodes({ runId: id, incomplete: "callback_failed" }).status,
    ).toBe(200);
    expect(
      backend.events
        .get(id)
        ?.filter((event) => event.type === "observation.incomplete"),
    ).toMatchObject([{ data: { reason: "callback_failed" } }]);
    expect(backend.runs.get(id)?.executions?.[0].status).toBe("completed");
  });
  it("rejects active capacity before 202 but accepts turnover at configured capacity", async () => {
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const dispatched: string[] = [];
    let occupied = false;
    const backend = new AgentsBackend(
      async ({ runId }) => {
        if (occupied) await stopped;
        occupied = true;
        dispatched.push(runId);
      },
      undefined,
      undefined,
      undefined,
      async () => {
        await stopped;
        occupied = false;
      },
      1,
    );
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const first = await run(app);
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatched).toEqual([first]);
    const busy = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send(start());
    expect(busy.status).toBe(503);
    expect(busy.body.error.code).toBe("workers_busy");
    const observation = started(first);
    expect(backend.observe(observation).status).toBe(200);
    expect(backend.observe(terminal(observation)).status).toBe(200);
    expect(backend.finalize(done(first)).status).toBe(200);
    const replacement = await run(app);
    expect(
      (await request(app).get(`/api/v1/runs/${replacement}`).set(auth)).body.run
        .status,
    ).toBe("running");
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatched).toEqual([first]);
    releaseStop();
    await stopped;
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatched).toEqual([first, replacement]);
    expect(backend.runs.get(replacement)?.run.status).toBe("running");
  });
  it("accepts without waiting, discovers conversations at start, and replays complete run snapshots", async () => {
    let resolve!: () => void;
    const { backend, app } = setup(
      async () =>
        await new Promise<void>((ready) => {
          resolve = ready;
        }),
    );
    const first = await run(app);
    const second = await run(app, "Another input");
    const page = await request(app).get("/api/v1/runs?limit=1").set(auth);
    expect(page.body.items).toHaveLength(1);
    expect(
      (await request(app).get(`/api/v1/runs/${first}`).set(auth)).body
        .conversations,
    ).toEqual([]);
    const next = await request(app)
      .get(`/api/v1/runs?limit=1&cursor=${page.body.nextCursor}`)
      .set(auth);
    expect(next.body.items[0].id).toBe(second);
    expect(backend.observe(node("node.deployed")).status).toBe(200);
    expect(backend.conversations.size).toBe(0);
    const a = started(first, randomUUID(), "step-a");
    const b = started(first, randomUUID(), "step-b");
    const c = started(first, randomUUID(), "step-a");
    const other = started(second, randomUUID(), "step-a");
    const observations = [a, b, c, other];
    const links = observations.map(
      (observation) => backend.observe(observation).body.conversationId!,
    );
    expect(
      backend.observe({
        ...a,
        eventId: randomUUID(),
        agentObservation: { runId: second },
      }).status,
    ).toBe(409);
    expect(new Set(links).size).toBe(4);
    expect(backend.observe(a).body.conversationId).toBe(links[0]);
    expect(
      backend.observe({
        ...a,
        input: { invocation: "prompt", prompt: "altered" },
      }).status,
    ).toBe(409);
    const snapshot = (await request(app).get(`/api/v1/runs/${first}`).set(auth))
      .body;
    expect(
      snapshot.conversations.map((link: { nodeId: string }) => link.nodeId),
    ).toEqual(["step-a", "step-b", "step-a"]);
    for (const id of links) {
      expect(
        (await request(app).get(`/api/v1/conversations/${id}`).set(auth))
          .status,
      ).toBe(200);
      expect(
        (
          await request(app)
            .get(`/api/v1/conversations/${id}/messages`)
            .set(auth)
        ).body.items,
      ).toMatchObject([{ role: "user", content: "Resolved input" }]);
      expect(
        backend.conversationEvents.get(id)?.map((event) => event.sequence),
      ).toEqual([1, 2]);
    }
    expect(backend.finalize(done(first)).status).toBe(409);
    expect(
      backend.observe({
        ...terminal(a),
        input: { invocation: "prompt", prompt: "wrong" },
      }).status,
    ).toBe(409);
    for (const observation of observations) {
      const result = terminal(observation);
      expect(backend.observe(result).status).toBe(200);
      expect(backend.observe(result).status).toBe(200);
      expect(backend.observe({ ...result, eventId: randomUUID() }).status).toBe(
        409,
      );
    }
    const final = done(first);
    expect(backend.finalize(final).status).toBe(200);
    expect(backend.finalize(final).status).toBe(200);
    expect(backend.finalize({ ...final, output: "other" }).status).toBe(409);
    expect(backend.observe(started(first)).status).toBe(409);
    expect(
      (await request(app).get(`/api/v1/runs/${first}`).set(auth)).body
        .conversations,
    ).toEqual(snapshot.conversations);
    expect(
      (await request(app).get(`/api/v1/runs/${second}`).set(auth)).body.run
        .status,
    ).toBe("running");
    expect(
      backend.messages.get(links[0])?.map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(
      backend.conversationEvents.get(links[0])?.map((event) => event.sequence),
    ).toEqual([1, 2, 3, 4, 5]);
    resolve();
  });

  it("maintains generation-safe inventory and repairs a missed deployment notice", async () => {
    const { backend, app } = setup();
    const old = node("node.deployed", "writer-agent", "old");
    const newer = node("node.deployed", "writer-agent", "new");
    expect(backend.observe(old).status).toBe(200);
    expect(backend.observe(newer).status).toBe(200);
    expect(
      backend.observe({ ...old, type: "node.closed", eventId: randomUUID() })
        .status,
    ).toBe(200);
    expect(backend.inventory.get("writer-agent")?.deploymentId).toBe("new");
    backend.observe({ ...old, eventId: randomUUID() });
    expect(backend.inventory.get("writer-agent")?.deploymentId).toBe("new");
    const id = await run(app);
    expect(
      backend.observe({ ...started(id), deploymentId: "old" }).status,
    ).toBe(409);
    expect(
      backend.observe({ ...newer, type: "node.closed", eventId: randomUUID() })
        .status,
    ).toBe(200);
    expect(backend.inventory.size).toBe(0);
    expect(
      backend.observe({ ...started(id), deploymentId: "new" }).status,
    ).toBe(409);
    expect(backend.observe(started(id)).status).toBe(200);
    expect(backend.inventory.get("writer-agent")?.deploymentId).toBe(
      "generation-1",
    );
  });

  it("retains attempted input after failure, rejects late writes and never invents output", async () => {
    const { backend, app } = setup();
    const id = await run(app);
    const observation = started(id);
    const conversationId = backend.observe(observation).body.conversationId!;
    const failed = terminal(observation, "failed");
    expect(backend.observe(failed).status).toBe(200);
    expect(backend.finalize(done(id)).status).toBe(409);
    expect(backend.finalize(done(id, "failed")).status).toBe(200);
    expect(backend.observe(terminal(observation)).status).toBe(409);
    expect(backend.observe(failed).status).toBe(200);
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${conversationId}/messages`)
          .set(auth)
      ).body.items,
    ).toHaveLength(1);
    expect(
      (await request(app).get(`/api/v1/runs/${id}`).set(auth)).body.run.status,
    ).toBe("failed");
    expect(backend.observe(started("unknown")).status).toBe(409);
    expect(backend.finalize(done("unknown")).status).toBe(409);
  });

  it("leaves a long-running execution active and only finalizes on explicit callback", async () => {
    const { backend, app } = setup();
    const id = await run(app);
    const observation = started(id);
    backend.observe(observation);
    const live = (await request(app).get(`/api/v1/runs/${id}`).set(auth)).body;
    expect(live.run.status).toBe("running");
    expect(live.conversations).toHaveLength(1);
    expect(backend.observe(terminal(observation, "timeout")).status).toBe(200);
    expect(
      (await request(app).get(`/api/v1/runs/${id}`).set(auth)).body.run.status,
    ).toBe("running");
    expect(backend.finalize(done(id, "failed")).status).toBe(200);
  });
});
