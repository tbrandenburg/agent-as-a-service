import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend } from "./backend.js";
import type { Executor } from "./backend.js";
import type { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";

const auth = { authorization: "Bearer test-token" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const setup = async (
  stop: (id: string) => Promise<void> = async () => {},
  dispatch: Executor = async () => {},
) => {
  const backend = new AgentsBackend(dispatch, undefined, undefined, stop);
  const app = createApp({
    token: "test-token",
    implementation: backend.implementation(),
  });
  const workflow = await request(app)
    .post("/api/v1/workflows")
    .set(auth)
    .send({
      engine: "node-red",
      specification: {
        entry: "entry",
        flows: [{ id: "entry", type: "link in" }],
      },
    });
  const body: z.infer<typeof schemas.runStart> = {
    target: { kind: "workflow", id: workflow.body.id as string },
    input: null,
  };
  const begin = async (
    input: z.infer<typeof schemas.runStart> = body,
    key = randomUUID(),
  ) => {
    const result = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .set("Idempotency-Key", key)
      .send(input);
    expect(result.status).toBe(202);
    return result;
  };
  return { backend, app, body, begin };
};
const final = (runId: string, status = "completed") => ({
  runId,
  status,
  eventId: randomUUID(),
  output: "done",
});
const observation = (runId: string) => ({
  version: 1,
  type: "execution.started",
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  nodeId: "writer-agent",
  deploymentId: "deployment",
  agent: "opencode",
  agentName: "Writer",
  executionId: randomUUID(),
  agentObservation: { runId },
  input: { invocation: "prompt", prompt: "remember" },
});

describe("Node-RED run controls", () => {
  it("returns 404 for unknown controls", async () => {
    const { app } = await setup();
    for (const action of ["cancel", "resume"])
      expect(
        (
          await request(app)
            .post(`/api/v1/runs/unknown/${action}`)
            .set(auth)
            .send({})
        ).status,
      ).toBe(404);
    expect(
      (await request(app).delete("/api/v1/runs/unknown").set(auth)).status,
    ).toBe(404);
  });

  it.each(["queued", "running", "paused"] as const)(
    "claims %s cancellation before callbacks and stops outside the mutation queue",
    async (status) => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stopping = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const stops: string[] = [];
      const { backend, app, begin } = await setup(async (id) => {
        stops.push(id);
        entered();
        await gate;
      });
      const id = (await begin()).body.run.id as string;
      await tick();
      backend.runs.get(id)!.run.status = status;
      expect(
        backend.observeNodes({
          runId: id,
          observations: [
            {
              sequence: 1,
              type: "received",
              nodeId: "slow",
              executionId: "node",
              status: "running",
            },
          ],
        }).status,
      ).toBe(status === "running" ? 200 : 409);
      const cancelling = request(app)
        .post(`/api/v1/runs/${id}/cancel`)
        .set(auth)
        .send({ reason: "user request" })
        .then((result) => result);
      await stopping;
      expect(backend.finalize(final(id)).status).toBe(409);
      expect(backend.finalize(final(id, "failed")).status).toBe(409);
      backend.workerFailed(id);
      expect(backend.runs.get(id)!.run.status).toBe(status);
      expect(backend.observe(observation(id)).status).toBe(409);
      expect(
        (
          await request(app)
            .post(`/api/v1/runs/${id}/cancel`)
            .set(auth)
            .send({})
        ).status,
      ).toBe(409);
      // A separate accepted start proves cancellation does not hold serial().
      expect((await begin()).status).toBe(202);
      release();
      const result = await cancelling;
      expect(result.status).toBe(200);
      expect(result.body.run.status).toBe("cancelled");
      expect(result.body.run.error).toBeUndefined();
      expect(stops).toEqual([id]);
      if (status === "running")
        expect(backend.runs.get(id)!.executions).toMatchObject([
          { status: "unconfirmed" },
        ]);
      expect(
        backend.events
          .get(id)!
          .filter((event) => event.type === "run.cancelled"),
      ).toMatchObject([{ data: { reason: "user request" } }]);
      expect(backend.drainNodes({ runId: id }).status).toBe(200);
      expect(backend.finalize(final(id)).status).toBe(409);
      backend.workerFailed(id);
      expect(backend.runs.get(id)!.run.status).toBe("cancelled");
    },
  );

  it("cancels direct agents using the same stop boundary", async () => {
    const stops: string[] = [];
    const { app, begin } = await setup(async (id) => {
      stops.push(id);
    });
    const accepted = await begin({
      target: { kind: "agent", id: "writer-agent" },
      input: { text: "wait" },
    });
    const id = accepted.body.run.id as string;
    await tick();
    const result = await request(app)
      .post(`/api/v1/runs/${id}/cancel`)
      .set(auth)
      .send({});
    expect(result.status).toBe(200);
    expect(result.body.run.status).toBe("cancelled");
    expect(stops).toEqual([id]);
  });

  it("returns a service failure for uncertain stop, retains the claim, and permits retry", async () => {
    let attempts = 0;
    const { backend, app, begin } = await setup(async () => {
      if (++attempts === 1) throw new Error("network unavailable");
    });
    const id = (await begin()).body.run.id as string;
    await tick();
    const failed = await request(app)
      .post(`/api/v1/runs/${id}/cancel`)
      .set(auth)
      .send({});
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("worker_stop_failed");
    backend.workerFailed(id);
    expect(backend.finalize(final(id)).status).toBe(409);
    expect(backend.runs.get(id)!.run.status).toBe("running");
    expect(
      (await request(app).delete(`/api/v1/runs/${id}`).set(auth)).status,
    ).toBe(409);
    expect(
      (await request(app).post(`/api/v1/runs/${id}/cancel`).set(auth).send({}))
        .status,
    ).toBe(200);
  });

  it("guards late dispatch failures and delayed dispatch after cancellation/deletion", async () => {
    let reject!: (error: Error) => void;
    const { backend, app, begin } = await setup(
      async () => {},
      async () =>
        new Promise<void>((_resolve, failure) => {
          reject = failure;
        }),
    );
    const id = (await begin()).body.run.id as string;
    await tick();
    expect(
      (await request(app).post(`/api/v1/runs/${id}/cancel`).set(auth).send({}))
        .status,
    ).toBe(200);
    expect(
      (await request(app).delete(`/api/v1/runs/${id}`).set(auth)).status,
    ).toBe(200);
    reject(new Error("late dispatch failure"));
    await tick();
    expect(backend.runs.has(id)).toBe(false);
    expect(backend.events.has(id)).toBe(false);
  });

  it.each([
    "queued",
    "running",
    "paused",
    "completed",
    "failed",
    "rejected",
    "cancelled",
  ] as const)(
    "resume never dispatches %s; deletion follows terminal status",
    async (status) => {
      const dispatched: string[] = [];
      const { backend, app, begin } = await setup(
        async () => {},
        async ({ runId }) => {
          dispatched.push(runId);
        },
      );
      const id = (await begin()).body.run.id as string;
      await tick();
      backend.runs.get(id)!.run.status = status;
      const resumed = await request(app)
        .post(`/api/v1/runs/${id}/resume`)
        .set(auth)
        .send({});
      expect(resumed.status).toBe(409);
      expect(resumed.body.error.code).toBe("run_not_resumable");
      const active = ["queued", "running", "paused"].includes(status);
      if (!active) {
        const cancelled = await request(app)
          .post(`/api/v1/runs/${id}/cancel`)
          .set(auth)
          .send({});
        expect(cancelled.status).toBe(409);
        expect(cancelled.body.error.code).toBe("run_not_active");
      }
      const removed = await request(app).delete(`/api/v1/runs/${id}`).set(auth);
      expect(removed.status).toBe(active ? 409 : 200);
      if (active) expect(removed.body.error.code).toBe("run_active");
      if (!active) {
        expect(removed.body).toEqual({ success: true });
        expect(
          (await request(app).get(`/api/v1/runs/${id}`).set(auth)).status,
        ).toBe(404);
        expect(
          (await request(app).get(`/api/v1/runs/${id}/events`).set(auth))
            .status,
        ).toBe(404);
        expect(
          (await request(app).get("/api/v1/runs").set(auth)).body.items,
        ).toEqual([]);
        expect(backend.finalize(final(id)).status).toBe(409);
        expect(backend.observe(observation(id)).status).toBe(409);
        expect(
          backend.observeNodes({
            runId: id,
            observations: [{ sequence: 1, type: "sent", nodeId: "late" }],
          }).status,
        ).toBe(409);
        backend.workerFailed(id);
        expect(backend.runs.has(id)).toBe(false);
      }
      await tick();
      expect(dispatched).toEqual([id]);
    },
  );

  it("terminal cancellation conflicts and deleted acceptance replays unchanged at 24h", async () => {
    const dispatched: string[] = [];
    const { backend, app, begin, body } = await setup(
      async () => {},
      async ({ runId }) => {
        dispatched.push(runId);
      },
    );
    const key = randomUUID();
    const accepted = await begin(body, key);
    const id = accepted.body.run.id as string;
    await tick();
    expect(backend.finalize(final(id)).status).toBe(200);
    expect(
      (await request(app).post(`/api/v1/runs/${id}/cancel`).set(auth).send({}))
        .body.error.code,
    ).toBe("run_not_active");
    expect(
      (await request(app).delete(`/api/v1/runs/${id}`).set(auth)).status,
    ).toBe(200);
    const original = Date.now;
    Date.now = () => original() + 86_399_000;
    try {
      expect((await begin(body, key)).body).toEqual(accepted.body);
    } finally {
      Date.now = original;
    }
    await tick();
    expect(dispatched).toEqual([id]);
    expect(backend.runs.has(id)).toBe(false);
  });

  it("deleting a direct run preserves conversation history and provider session continuation", async () => {
    const dispatched: Parameters<Executor>[0][] = [];
    const { backend, app } = await setup(
      async () => {},
      async (payload) => {
        dispatched.push(payload);
      },
    );
    const body = {
      target: { kind: "agent", id: "writer-agent" },
      input: { text: "remember" },
    };
    const accepted = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send(body);
    const id = accepted.body.run.id as string;
    await tick();
    const started = observation(id);
    const conversationId = backend.observe(started).body.conversationId!;
    expect(
      backend.observe({
        ...started,
        eventId: randomUUID(),
        type: "execution.terminal",
        status: "completed",
        sessionID: "private-session",
        output: { payload: "remembered" },
      }).status,
    ).toBe(200);
    expect(backend.finalize(final(id)).status).toBe(200);
    expect(
      (await request(app).delete(`/api/v1/runs/${id}`).set(auth)).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${conversationId}`)
          .set(auth)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${conversationId}/messages`)
          .set(auth)
      ).body.items,
    ).toHaveLength(2);
    expect(
      (
        await request(app)
          .post("/api/v1/runs")
          .set(auth)
          .send({ ...body, conversationId })
      ).status,
    ).toBe(202);
    await tick();
    expect(dispatched[1].sessionID).toBe("private-session");
    expect(backend.finalize(final(id)).status).toBe(409);
    expect(backend.runs.has(id)).toBe(false);
  });
});
