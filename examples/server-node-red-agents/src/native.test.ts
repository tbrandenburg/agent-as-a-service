import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend, type Executor } from "./backend.js";
import { JsonStore, type Store } from "./registry.js";
import { validate } from "./native.js";

const auth = { authorization: "Bearer test-token" };
export const input = (name = "Native") => ({
  name,
  engine: "node-red",
  specification: {
    entry: "entry",
    flows: [
      { id: "main", type: "tab" },
      { id: "entry", z: "main", type: "link in", wires: [["work"]] },
      {
        id: "work",
        z: "main",
        type: "function",
        func: "msg.payload=msg.input;return msg;",
        wires: [["return"]],
      },
      { id: "return", z: "main", type: "link out", mode: "return" },
    ],
  },
});

describe("stored native workflows", () => {
  it("resolves Core once without persisting it, guards mutation and snapshots idempotent starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaas-core-registry-"));
    try {
      const disk = new JsonStore(join(root, "workflows.json"));
      const payloads: Parameters<Executor>[0][] = [];
      const backend = new AgentsBackend(async (payload) => {
        payloads.push(payload);
      }, disk);
      await backend.initialize();
      const app = createApp({
        token: "test-token",
        implementation: backend.implementation(),
      });
      const core = await request(app).get("/api/v1/workflows/core").set(auth);
      expect(core.status).toBe(200);
      expect(core.headers.etag).toBe('"v1"');
      expect(core.body).toMatchObject({
        id: "core",
        name: "Core",
        version: 1,
        readOnly: true,
      });
      expect(validate(core.body)).toEqual([]);
      for (const method of ["put", "delete"] as const) {
        const response = await request(app)
          [method]("/api/v1/workflows/core")
          .set(auth)
          .send(method === "put" ? input() : undefined);
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("workflow_read_only");
      }
      const created = await request(app)
        .post("/api/v1/workflows")
        .set(auth)
        .send(input());
      expect(created.status).toBe(201);
      expect(Object.keys(await disk.load())).toEqual([created.body.id]);
      const listed = await request(app).get("/api/v1/workflows").set(auth);
      expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([
        "core",
        created.body.id,
      ]);
      const body = {
        target: { kind: "workflow", id: "core" },
        input: { text: "Reply briefly" },
      };
      const accepted = await request(app)
        .post("/api/v1/runs")
        .set({ ...auth, "idempotency-key": "core-start" })
        .send(body);
      expect(accepted.status).toBe(202);
      expect(accepted.body.run).toMatchObject({
        workflowVersion: 1,
        target: body.target,
      });
      expect(
        (
          await request(app)
            .get(`/api/v1/runs/${accepted.body.run.id}`)
            .set(auth)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app)
            .post("/api/v1/runs")
            .set({ ...auth, "idempotency-key": "core-start" })
            .send(body)
        ).body,
      ).toEqual(accepted.body);
      await new Promise((resolve) => setImmediate(resolve));
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        entry: "workflow-in",
        input: body.input,
        flows: core.body.specification.flows,
      });
      payloads[0].flows[0].label = "Changed snapshot";
      expect(
        (await request(app).get("/api/v1/workflows/core").set(auth)).body,
      ).toEqual(core.body);
      const rejected = await request(app)
        .post("/api/v1/runs")
        .set(auth)
        .send({ ...body, conversationId: "unknown" });
      expect(rejected.status).toBe(501);
      expect(rejected.body.error.code).toBe(
        "conversation_continuation_unsupported",
      );
      expect(
        (
          await request(app)
            .post("/api/v1/runs")
            .set(auth)
            .send({ ...body, target: { kind: "workflow", id: "unknown" } })
        ).status,
      ).toBe(404);
      await new Promise((resolve) => setImmediate(resolve));
      expect(payloads).toHaveLength(1);
      expect(backend.runs.size).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates only envelope and selected Link In", () => {
    const native = input();
    native.specification.flows.push(
      ...([
        { id: "second", type: "tab" },
        { id: "other", type: "link in", z: "second" },
        { type: "subflow", id: "sub", in: [], out: [] },
        { type: "subflow:sub", z: "second" },
        { type: "agent", credentials: { arbitrary: true } },
        { type: "change" },
        { type: "switch" },
        { type: "mqtt in" },
        { type: "exec" },
        { type: "unknown-community-config" },
      ] as typeof native.specification.flows),
    );
    expect(validate(native)).toEqual([]);
    for (const specification of [
      "bad",
      {},
      { entry: "entry", flows: [] },
      { entry: "entry", flows: [null] },
      { entry: "work", flows: native.specification.flows },
      { entry: "absent", flows: native.specification.flows },
      {
        entry: "entry",
        flows: [...native.specification.flows, native.specification.flows[1]],
      },
    ])
      expect(validate({ ...native, specification })).not.toEqual([]);
    expect(validate({ ...native, engine: "other" })).not.toEqual([]);
  });

  it("keeps atomic persisted CRUD, ETags and accepted snapshots through concurrent update/delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaas-native-registry-"));
    try {
      const disk = new JsonStore(join(root, "workflows.json"));
      let fail = false;
      const store: Store = {
        load: () => disk.load(),
        save: (registry) => {
          if (fail) throw new Error("disk unavailable");
          return disk.save(registry);
        },
      };
      const payloads: Parameters<Executor>[0][] = [];
      const backend = new AgentsBackend(async (payload) => {
        payloads.push(payload);
      }, store);
      await backend.initialize();
      const app = createApp({
        token: "test-token",
        implementation: backend.implementation(),
      });
      const created = await request(app)
        .post("/api/v1/workflows")
        .set(auth)
        .send(input());
      expect(created.status).toBe(201);
      expect(created.headers.etag).toBe('"v1"');
      const id = created.body.id as string;
      expect(id).not.toBe("main");
      expect(created.body.specification).toEqual(input().specification);
      const run = await request(app)
        .post("/api/v1/runs")
        .set(auth)
        .send({ target: { kind: "workflow", id }, input: null });
      expect(run.status).toBe(202);
      expect(run.body.run.workflowVersion).toBe(1);
      const mutations = await Promise.all(
        ["Updated", "Stale"].map((name) =>
          request(app)
            .put(`/api/v1/workflows/${id}`)
            .set({ ...auth, "if-match": '"v1"' })
            .send(input(name)),
        ),
      );
      expect(mutations.map((result) => result.status).sort()).toEqual([
        200, 412,
      ]);
      expect(
        mutations.find((result) => result.status === 200)?.headers.etag,
      ).toBe('"v2"');
      await new Promise((resolve) => setImmediate(resolve));
      expect(payloads[0].flows).toEqual(input().specification.flows);
      expect(payloads[0].input).toBeNull();
      fail = true;
      expect(
        (
          await request(app)
            .put(`/api/v1/workflows/${id}`)
            .set(auth)
            .send(input("Failed"))
        ).status,
      ).toBe(503);
      expect(
        (await request(app).delete(`/api/v1/workflows/${id}`).set(auth)).status,
      ).toBe(503);
      expect(
        (
          await request(app)
            .post("/api/v1/workflows")
            .set(auth)
            .send(input("Failed"))
        ).status,
      ).toBe(503);
      expect((await disk.load())[id].version).toBe(2);
      const reloaded = new AgentsBackend(async () => {}, disk);
      await reloaded.initialize();
      const restarted = createApp({
        token: "test-token",
        implementation: reloaded.implementation(),
      });
      expect(
        (await request(restarted).get(`/api/v1/workflows/${id}`).set(auth))
          .headers.etag,
      ).toBe('"v2"');
      fail = false;
      expect(
        (await request(app).delete(`/api/v1/workflows/${id}`).set(auth)).status,
      ).toBe(200);
      expect(
        backend.finalize({
          runId: run.body.run.id,
          eventId: "final",
          status: "completed",
          output: -110,
        }).status,
      ).toBe(200);
      expect(
        (await request(app).get(`/api/v1/runs/${run.body.run.id}`).set(auth))
          .body.run,
      ).toMatchObject({
        workflowVersion: 1,
        output: -110,
        status: "completed",
      });
      expect(
        (
          await request(app)
            .post("/api/v1/runs")
            .set(auth)
            .send({ target: { kind: "workflow", id }, input: true })
        ).status,
      ).toBe(404);
      expect(await disk.load()).toEqual({});
      expect(
        (await request(app).get("/api/v1/workflows").set(auth)).body.items,
      ).toMatchObject([{ id: "core", readOnly: true }]);
      expect(
        (await request(app).get("/api/v1/workflows/toString").set(auth)).status,
      ).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
