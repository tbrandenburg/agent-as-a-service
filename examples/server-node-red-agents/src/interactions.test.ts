import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend } from "./backend.js";
import type { Executor } from "./backend.js";
import { serializable } from "./interaction.js";

const auth = { authorization: "Bearer test-token" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function setup() {
  const payloads: Parameters<Executor>[0][] = [];
  const stops: string[] = [];
  let rejectAdmission = false;
  let loseResponse = false;
  let admissionGate: Promise<void> | undefined;
  const backend = new AgentsBackend(
    async (payload) => {
      payloads.push(payload);
      if (!payload.resume) return;
      await admissionGate;
      if (rejectAdmission) throw new Error("Capacity unavailable");
      if (
        backend.admitted({ runId: payload.runId, attemptId: payload.attemptId })
          .status !== 200
      )
        throw new Error("Admission rejected");
      if (loseResponse)
        throw new Error("Dispatch response lost after admission");
    },
    undefined,
    undefined,
    async (id) => {
      stops.push(id);
    },
    1,
    async () => 0,
  );
  const app = createApp({
    token: "test-token",
    implementation: backend.implementation(),
  });
  const definition = {
    engine: "node-red",
    specification: {
      entry: "entry",
      flows: [
        { id: "entry", type: "link in", wires: [["human"]] },
        { id: "human", type: "interaction", wires: [["after"]] },
        { id: "after", type: "change" },
      ],
    },
  };
  const workflow = await request(app)
    .post("/api/v1/workflows")
    .set(auth)
    .send(definition);
  expect(workflow.status).toBe(201);
  async function pause() {
    const started = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send({
        target: { kind: "workflow", id: workflow.body.id },
        input: { original: "preserved" },
      });
    expect(started.status).toBe(202);
    await tick();
    const payload = payloads.at(-1)!;
    const record = {
      runId: payload.runId,
      attemptId: payload.attemptId,
      version: 1,
      plan: {
        version: 1,
        interactionId: randomUUID(),
        nodeId: "human",
        nodeName: "Human",
        prompt: "Continue?",
        decisions: [
          { id: "approve", label: "Approve" },
          { id: "revise", label: "Revise" },
        ],
      },
      msg: {
        before: 1,
        input: payload.input,
        _linkSource: [{ id: "stale-call", node: "stale-host" }],
      },
    };
    expect(backend.suspend(record).status).toBe(200);
    expect(backend.suspend(record).status).toBe(200);
    await tick();
    return record;
  }
  const decide = (
    id: string,
    body = { decision: "revise", comment: "add one more test" },
    key?: string,
  ) =>
    request(app)
      .post(`/api/v1/interactions/${id}/decisions`)
      .set(auth)
      .set(key ? { "Idempotency-Key": key } : {})
      .send(body);
  return {
    backend,
    app,
    payloads,
    stops,
    workflow,
    definition,
    pause,
    decide,
    reject: () => {
      rejectAdmission = true;
    },
    allow: () => {
      rejectAdmission = false;
    },
    gate: (value: Promise<void>) => {
      admissionGate = value;
    },
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

describe("Interaction public API and private continuation", () => {
  it("terminates an admitted Run when launch acknowledgement is lost, with stable terminal replay", async () => {
    const fixture = await setup();
    const record = await fixture.pause();
    fixture.loseResponse();
    const key = randomUUID();
    const accepted = await fixture.decide(
      record.plan.interactionId,
      undefined,
      key,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.run.status).toBe("failed");
    expect(accepted.body.run.error.code).toBe(
      "continuation_launch_unconfirmed",
    );
    expect(fixture.backend.runs.get(record.runId)!.run.status).toBe("failed");
    expect(
      (await fixture.decide(record.plan.interactionId, undefined, key)).body,
    ).toEqual(accepted.body);
    expect(fixture.payloads).toHaveLength(2);
    expect(fixture.stops).toEqual([
      record.attemptId,
      fixture.payloads[1].attemptId,
    ]);
    expect(
      fixture.backend.finalize({
        runId: record.runId,
        attemptId: fixture.payloads[1].attemptId,
        eventId: "late",
        status: "completed",
        output: "late",
      }).status,
    ).toBe(409);
  });
  it("lists pending ordered choices with pagination and project filter; continues same run from the accepted snapshot", async () => {
    const {
      app,
      backend,
      payloads,
      stops,
      workflow,
      definition,
      pause,
      decide,
    } = await setup();
    const first = await pause();
    const second = await pause();
    expect(stops).toEqual([first.attemptId, second.attemptId]);
    backend.workerFailed(first.runId, first.attemptId);
    expect(backend.runs.get(first.runId)!.run.status).toBe("paused");
    const pending = await request(app)
      .get("/api/v1/interactions?limit=1")
      .set(auth);
    expect(pending.body.items).toEqual([
      {
        id: first.plan.interactionId,
        runId: first.runId,
        prompt: "Continue?",
        decisions: ["approve", "revise"],
        status: "pending",
      },
    ]);
    expect(
      (
        await request(app)
          .get(`/api/v1/interactions?limit=1&cursor=${pending.body.nextCursor}`)
          .set(auth)
      ).body.items[0].id,
    ).toBe(second.plan.interactionId);
    expect(
      (await request(app).get("/api/v1/interactions?projectId=other").set(auth))
        .body.items,
    ).toEqual([]);
    expect(
      (await request(app).get("/api/v1/interactions?cursor=wrong").set(auth))
        .status,
    ).toBe(400);
    const original = payloads[0];
    expect(
      (
        await request(app)
          .put(`/api/v1/workflows/${workflow.body.id}`)
          .set(auth)
          .send({
            ...definition,
            specification: {
              ...definition.specification,
              flows: [{ id: "entry", type: "link in" }],
            },
          })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/api/v1/runs/${first.runId}/resume`)
          .set(auth)
          .send({})
      ).body.error.code,
    ).toBe("run_not_resumable");
    const result = await decide(first.plan.interactionId);
    expect(result.status).toBe(200);
    expect(result.body.run.id).toBe(first.runId);
    expect(result.body.run.status).toBe("running");
    const resumed = payloads.at(-1)!;
    expect(resumed.attemptId).not.toBe(first.attemptId);
    expect(resumed.flows).toEqual(original.flows);
    expect(resumed.resume).toEqual({
      plan: first.plan,
      msg: first.msg,
      response: { decision: "revise", text: "add one more test" },
    });
    expect(
      backend.finalize({
        runId: first.runId,
        attemptId: first.attemptId,
        eventId: "stale",
        status: "failed",
      }).status,
    ).toBe(409);
    expect(
      backend.finalize({
        runId: first.runId,
        attemptId: resumed.attemptId,
        eventId: "finish",
        status: "completed",
        output: { before: 1, after: 1 },
      }).status,
    ).toBe(200);
    expect(backend.runs.size).toBe(2);
    expect(
      (await request(app).get("/api/v1/interactions").set(auth)).body.items,
    ).toHaveLength(1);
  });

  it("rejects unknown/invalid/duplicate decisions and replays idempotency without new attempts", async () => {
    const { pause, decide, payloads } = await setup();
    const record = await pause();
    expect((await decide("unknown")).status).toBe(404);
    expect(
      (
        await decide(record.plan.interactionId, {
          decision: "invalid",
          comment: "",
        })
      ).status,
    ).toBe(400);
    const key = randomUUID();
    const accepted = await decide(record.plan.interactionId, undefined, key);
    expect(accepted.status).toBe(200);
    expect(
      (await decide(record.plan.interactionId, undefined, key)).body,
    ).toEqual(accepted.body);
    expect(
      (
        await decide(
          record.plan.interactionId,
          { decision: "approve", comment: "different" },
          key,
        )
      ).body.error.code,
    ).toBe("idempotency_conflict");
    expect((await decide(record.plan.interactionId)).status).toBe(409);
    expect(payloads).toHaveLength(2);
  });

  it("leaves failed admission pending and retryable; cancellation beats admission", async () => {
    const fixture = await setup();
    const record = await fixture.pause();
    fixture.reject();
    expect((await fixture.decide(record.plan.interactionId)).status).toBe(503);
    expect(fixture.backend.runs.get(record.runId)!.run.status).toBe("paused");
    expect(
      (await request(fixture.app).get("/api/v1/interactions").set(auth)).body
        .items,
    ).toHaveLength(1);
    fixture.allow();
    let release!: () => void;
    fixture.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const deciding = fixture
      .decide(record.plan.interactionId)
      .then((value) => value);
    while (fixture.payloads.length < 3) await tick();
    expect(
      (
        await request(fixture.app)
          .post(`/api/v1/runs/${record.runId}/cancel`)
          .set(auth)
          .send({})
      ).status,
    ).toBe(200);
    release();
    expect((await deciding).status).toBe(503);
    expect((await fixture.decide(record.plan.interactionId)).status).toBe(409);
    expect(
      (await request(fixture.app).get("/api/v1/interactions").set(auth)).body
        .items,
    ).toEqual([]);
  });

  it("rejects corrupt/non-serializable checkpoints before pausing", async () => {
    const { backend, pause } = await setup();
    const record = await pause();
    for (const msg of [
      { value: undefined },
      { value: NaN },
      { value: new Date() },
      { value: Buffer.from("x") },
      { value: () => {} },
    ])
      expect(backend.suspend({ ...record, msg }).status).toBe(400);
    expect(
      backend.suspend({ ...record, plan: { ...record.plan, version: 2 } })
        .status,
    ).toBe(400);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializable(cyclic)).toBe(false);
    expect(serializable({ nested: [null, true, 1, "value"] })).toBe(true);
  });
  it("rejects missing or corrupt retained checkpoints without dispatch", async () => {
    const fixture = await setup();
    const record = await fixture.pause();
    const jobs = Reflect.get(fixture.backend, "jobs") as Map<
      string,
      { checkpoint?: { plan: unknown; msg: unknown } }
    >;
    const job = jobs.get(record.runId)!;
    const saved = job.checkpoint;
    job.checkpoint = undefined;
    expect(
      (await fixture.decide(record.plan.interactionId)).body.error.code,
    ).toBe("checkpoint_invalid");
    job.checkpoint = { plan: { version: 2 }, msg: {} };
    expect(
      (await fixture.decide(record.plan.interactionId)).body.error.code,
    ).toBe("checkpoint_invalid");
    job.checkpoint = { plan: saved!.plan, msg: "primitive" };
    expect(
      (await fixture.decide(record.plan.interactionId)).body.error.code,
    ).toBe("checkpoint_invalid");
    expect(fixture.payloads).toHaveLength(1);
    job.checkpoint = saved;
    expect((await fixture.decide(record.plan.interactionId)).status).toBe(200);
  });
});
