import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend } from "./backend.js";

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
const setup = (
  dispatch: (payload: {
    runId: string;
    text: string;
  }) => Promise<void> = async () => {},
) => {
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
    const a = started(first);
    const b = started(first, randomUUID(), "reviewer-agent");
    const c = started(first);
    const other = started(second);
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
    ).toEqual(["writer-agent", "reviewer-agent", "writer-agent"]);
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
