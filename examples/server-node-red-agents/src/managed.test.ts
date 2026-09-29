import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend } from "./backend.js";
import type { Admin, Store } from "./admin.js";
import type { Registry, Tab } from "./managed.js";
import { validate } from "./managed.js";

const auth = { authorization: "Bearer test-token" };
const input = (label = "Writer") => ({
  engine: "node-red",
  specificationVersion: "managed-v1",
  specification: {
    label,
    entry: "writer",
    finalizer: "writer",
    configs: [],
    nodes: [{ id: "writer", type: "agent", name: "Writer", wires: [[], []] }],
  },
});

function setup() {
  const tabs = new Map<string, Tab>();
  const calls: string[] = [];
  let registry: Registry = {};
  let failSave = false;
  let failDeploy = false;
  const admin: Admin = {
    async get(id) {
      return tabs.get(id) ?? null;
    },
    async create(tab) {
      calls.push("create");
      if (failDeploy) throw new Error("deployment failed");
      tabs.set("assigned-id", { ...tab, id: "assigned-id" });
      return "assigned-id";
    },
    async update(id, tab) {
      calls.push("update");
      if (failDeploy) throw new Error("deployment failed");
      tabs.set(id, { ...tab, id });
    },
    async delete(id) {
      calls.push("delete");
      tabs.delete(id);
    },
  };
  const store: Store = {
    async load() {
      return structuredClone(registry);
    },
    async save(next) {
      calls.push("save");
      if (failSave) throw new Error("disk full");
      registry = structuredClone(next);
    },
  };
  const backend = new AgentsBackend(async () => {}, admin, store);
  const app = createApp({
    token: "test-token",
    implementation: backend.implementation(),
  });
  return {
    app,
    backend,
    tabs,
    calls,
    setFailSave: (value: boolean) => {
      failSave = value;
    },
    setFailDeploy: (value: boolean) => {
      failDeploy = value;
    },
    store,
  };
}

describe("managed workflow boundary", () => {
  it("rejects unsupported graphs and private boundary overrides", () => {
    for (const specification of [
      "not deployable",
      {
        ...input().specification,
        nodes: [{ id: "writer", type: "function", name: "X", wires: [[], []] }],
      },
      {
        ...input().specification,
        nodes: [input().specification.nodes[0], input().specification.nodes[0]],
      },
      {
        ...input().specification,
        nodes: [{ ...input().specification.nodes[0], wires: [["absent"], []] }],
      },
      {
        ...input().specification,
        nodes: [
          {
            ...input().specification.nodes[0],
            credentials: { password: "secret" },
          },
        ],
      },
      { ...input().specification, endpoint: "/private" },
    ])
      expect(validate({ ...input(), specification })).not.toEqual([]);
  });

  it("serializes per-tab CRUD, strong ETags, stale guards, active runs, and retained history", async () => {
    const { app, tabs, calls, backend } = setup();
    expect(
      (
        await request(app)
          .put("/api/v1/workflows/node-red-demo")
          .set(auth)
          .send(input())
      ).status,
    ).toBe(403);
    expect(
      (await request(app).delete("/api/v1/workflows/node-red-demo").set(auth))
        .status,
    ).toBe(403);
    expect(
      (await request(app).delete("/api/v1/workflows/missing").set(auth)).status,
    ).toBe(404);
    const created = await request(app)
      .post("/api/v1/workflows")
      .set(auth)
      .send(input());
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"v1"');
    const id = created.body.id as string;
    expect(id).toBe("assigned-id");
    expect(tabs.has(id)).toBe(true);
    expect(
      (await request(app).get(`/api/v1/workflows/${id}`).set(auth)).headers
        .etag,
    ).toBe('"v1"');
    expect(
      (await request(app).get("/api/v1/workflows").set(auth)).body.items.map(
        (item: { name: string }) => item.name,
      ),
    ).toEqual(["Core", "Writer"]);
    expect(
      (
        await request(app)
          .put(`/api/v1/workflows/${id}`)
          .set({ ...auth, "if-match": '"v0"' })
          .send(input("Stale"))
      ).status,
    ).toBe(400);
    const stale = await request(app)
      .put(`/api/v1/workflows/${id}`)
      .set({ ...auth, "if-match": '"v9"' })
      .send(input("Stale"));
    expect(stale.status).toBe(412);
    expect(calls).toEqual(["create", "save"]);
    const run = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send({
        target: { kind: "workflow", workflowId: id },
        input: { text: "Test" },
      });
    expect(run.status).toBe(202);
    expect(run.body.run.workflowVersion).toBe(1);
    expect(
      (
        await request(app)
          .put(`/api/v1/workflows/${id}`)
          .set(auth)
          .send(input("Blocked"))
      ).status,
    ).toBe(409);
    expect(
      (await request(app).delete(`/api/v1/workflows/${id}`).set(auth)).status,
    ).toBe(409);
    expect(calls).toEqual(["create", "save"]);
    // The explicit failure boundary ends the run without an agent observation.
    expect(
      (await request(app).get(`/api/v1/runs/${run.body.run.id}`).set(auth)).body
        .run.status,
    ).toBe("running");
    expect(
      backend.finalize({
        runId: run.body.run.id,
        eventId: "terminal",
        status: "failed",
      }).status,
    ).toBe(200);
    const updated = await request(app)
      .put(`/api/v1/workflows/${id}`)
      .set({ ...auth, "if-match": '"v1"' })
      .send(input("Updated"));
    expect(updated.status).toBe(200);
    expect(updated.headers.etag).toBe('"v2"');
    expect(tabs.get(id)?.label).toBe("Updated");
    expect(
      (
        await request(app)
          .put(`/api/v1/workflows/${id}`)
          .set({ ...auth, "if-match": '"v1"' })
          .send(input("Stale"))
      ).status,
    ).toBe(412);
    expect(
      (
        await request(app)
          .put(`/api/v1/workflows/${id}`)
          .set(auth)
          .send(input("Unconditional"))
      ).headers.etag,
    ).toBe('"v3"');
    expect(
      (await request(app).delete(`/api/v1/workflows/${id}`).set(auth)).body,
    ).toEqual({ success: true });
    expect(tabs.has(id)).toBe(false);
    expect(
      (await request(app).get(`/api/v1/workflows/${id}`).set(auth)).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/api/v1/runs")
          .set(auth)
          .send({
            target: { kind: "workflow", workflowId: id },
            input: { text: "New" },
          })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/v1/runs/${run.body.run.id}`).set(auth)).body
        .run.workflowVersion,
    ).toBe(1);
  });

  it("does not publish failed deployments or registry writes and reconciles drift", async () => {
    const { app, tabs, calls, setFailSave, setFailDeploy, store } = setup();
    setFailDeploy(true);
    expect(
      (await request(app).post("/api/v1/workflows").set(auth).send(input()))
        .status,
    ).toBe(503);
    expect(calls).toEqual(["create"]);
    setFailDeploy(false);
    setFailSave(true);
    expect(
      (await request(app).post("/api/v1/workflows").set(auth).send(input()))
        .status,
    ).toBe(503);
    expect(calls).toEqual(["create", "create", "save", "delete"]);
    expect(tabs.size).toBe(0);
    setFailSave(false);
    expect(
      (await request(app).post("/api/v1/workflows").set(auth).send(input()))
        .status,
    ).toBe(201);
    setFailDeploy(true);
    expect(
      (
        await request(app)
          .put("/api/v1/workflows/assigned-id")
          .set(auth)
          .send(input("Broken"))
      ).status,
    ).toBe(503);
    expect(
      (await request(app).get("/api/v1/workflows/assigned-id").set(auth))
        .headers.etag,
    ).toBe('"v1"');
    setFailDeploy(false);
    setFailSave(true);
    expect(
      (
        await request(app)
          .put("/api/v1/workflows/assigned-id")
          .set(auth)
          .send(input("Failed write"))
      ).status,
    ).toBe(503);
    expect(
      (await request(app).get("/api/v1/workflows/assigned-id").set(auth))
        .headers.etag,
    ).toBe('"v1"');
    expect(tabs.get("assigned-id")?.label).toBe("Writer");
    setFailSave(false);
    tabs.delete("assigned-id");
    const reloaded = new AgentsBackend(
      async () => {},
      {
        get: async (id) => tabs.get(id) ?? null,
        create: async () => {
          throw new Error("not needed");
        },
        update: async () => {
          throw new Error("not needed");
        },
        delete: async () => {
          throw new Error("not needed");
        },
      },
      store,
    );
    await reloaded.initialize();
    const drift = createApp({
      token: "test-token",
      implementation: reloaded.implementation(),
    });
    expect(
      (await request(drift).get("/api/v1/workflows").set(auth)).body.items,
    ).toHaveLength(1);
    expect(
      (
        await request(drift)
          .post("/api/v1/runs")
          .set(auth)
          .send({
            target: { kind: "workflow", workflowId: "assigned-id" },
            input: { text: "Test" },
          })
      ).status,
    ).toBe(503);
  });
});
