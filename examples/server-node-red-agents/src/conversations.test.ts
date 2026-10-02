import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend } from "./backend.js";
import type { Executor } from "./backend.js";
import { Projects } from "./projects.js";

const auth = { authorization: "Bearer test-token" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const setup = async (projects?: Projects) => {
  const dispatched: Parameters<Executor>[0][] = [];
  const stopped: string[] = [];
  const backend = new AgentsBackend(
    async (payload) => {
      dispatched.push(payload);
    },
    undefined,
    projects,
    async (id) => {
      stopped.push(id);
    },
  );
  await backend.initialize();
  const app = createApp({
    token: "test-token",
    implementation: backend.implementation(),
  });
  const create = async (body: Record<string, unknown> = {}) => {
    const response = await request(app)
      .post("/api/v1/conversations")
      .set(auth)
      .send(body);
    expect(response.status).toBe(201);
    return response.body.id as string;
  };
  const send = (id: string, content = "New turn", key?: string) =>
    request(app)
      .post(`/api/v1/conversations/${id}/messages`)
      .set(auth)
      .set(key ? { "idempotency-key": key } : {})
      .send({ content });
  const history = (id: string) =>
    request(app).get(`/api/v1/conversations/${id}/messages`).set(auth);
  return { backend, app, create, send, history, dispatched, stopped };
};
const started = (runId: string, nodeId = "orchestrator") => ({
  version: 1,
  type: "execution.started",
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  nodeId,
  deploymentId: randomUUID(),
  agent: "opencode",
  agentName: "Current agent",
  executionId: randomUUID(),
  agentObservation: { runId },
  input: { invocation: "prompt", prompt: "New turn" },
});
const complete = (
  backend: AgentsBackend,
  runId: string,
  options: {
    nodeId?: string;
    status?: string;
    resumed?: boolean;
    sessionID?: string;
    finalize?: boolean;
  } = {},
) => {
  const start = started(runId, options.nodeId);
  const result = backend.observe(start);
  expect(result.status).toBe(200);
  expect(
    backend.observe({
      ...start,
      type: "execution.terminal",
      eventId: randomUUID(),
      status: options.status ?? "completed",
      sessionID: options.sessionID ?? "private-session",
      resumed: options.resumed,
      output: { payload: "Reply" },
    }).status,
  ).toBe(200);
  if (options.finalize !== false)
    expect(
      backend.finalize({
        runId,
        eventId: randomUUID(),
        status: "completed",
        output: "Reply",
      }).status,
    ).toBe(200);
  return result.body.conversationId!;
};
const workflow = (type = "agent", extra: Record<string, unknown> = {}) => ({
  engine: "node-red",
  specification: {
    entry: "entry",
    flows: [
      { id: "tab", type: "tab" },
      {
        id: "entry",
        type: "link in",
        z: "tab",
        x: 100,
        y: 100,
        wires: [["side-effect"]],
      },
      {
        id: "side-effect",
        type: "function",
        z: "tab",
        func: "throw Error('must not replay')",
        wires: [["exact-agent"]],
      },
      {
        id: "exact-agent",
        type,
        z: "tab",
        x: 250,
        y: 100,
        name: "original",
        model: "v1",
        runtime: "direct",
        ...extra,
        wires: [["return"], ["progress"]],
      },
      { id: "return", type: "link out", z: "tab", mode: "return" },
      { id: "config", type: "agent-config" },
    ],
  },
});

describe("conversation CRUD and continuation", () => {
  it("serializes concurrent accepts and guards linked queued/running/paused runs", async () => {
    const { app, backend, create, send } = await setup();
    const id = await create();
    const responses = await Promise.all([send(id), send(id)]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);
    const accepted = responses.find((response) => response.status === 202)!;
    for (const status of ["queued", "running", "paused"] as const) {
      backend.runs.get(accepted.body.run.id)!.run.status = status;
      expect((await send(id)).body.error.code).toBe("conversation_busy");
      expect(
        (await request(app).delete(`/api/v1/conversations/${id}`).set(auth))
          .body.error.code,
      ).toBe("conversation_active");
    }
    backend.workerFailed(accepted.body.run.id);
    expect((await send(id)).status).toBe(202);
  });
  it("retains established session after late cancellation or failed finalization and discards staged messages", async () => {
    const { app, backend, create, send, history, dispatched } = await setup();
    const id = await create();
    complete(backend, (await send(id)).body.run.id);
    for (const mode of ["cancel", "failed-finalize"]) {
      const accepted = await send(id);
      await tick();
      complete(backend, accepted.body.run.id, {
        resumed: true,
        sessionID: "staged-session",
        finalize: false,
      });
      if (mode === "cancel")
        expect(
          (
            await request(app)
              .post(`/api/v1/runs/${accepted.body.run.id}/cancel`)
              .set(auth)
              .send({})
          ).status,
        ).toBe(200);
      else
        expect(
          backend.finalize({
            runId: accepted.body.run.id,
            eventId: randomUUID(),
            status: "failed",
          }).status,
        ).toBe(200);
      expect((await history(id)).body.items).toHaveLength(2);
      const retry = await send(id);
      await tick();
      expect(dispatched.at(-1)!.input).toEqual({
        text: "New turn",
        sessionID: "private-session",
      });
      backend.workerFailed(retry.body.run.id);
    }
  });

  it("fails a turn without acknowledged terminal or after dispatch error without persisting a pair", async () => {
    const backend = new AgentsBackend(async () => {
      throw new Error("Unavailable runtime");
    });
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const created = await request(app)
      .post("/api/v1/conversations")
      .set(auth)
      .send({});
    const accepted = await request(app)
      .post(`/api/v1/conversations/${created.body.id}/messages`)
      .set(auth)
      .send({ content: "New turn" });
    await tick();
    expect(backend.runs.get(accepted.body.run.id)?.run).toMatchObject({
      status: "failed",
      error: { code: "dispatch_failed" },
    });
    expect(backend.messages.get(created.body.id)).toEqual([]);
    const normal = await setup();
    const id = await normal.create();
    const unconfirmed = await normal.send(id);
    expect(
      normal.backend.finalize({
        runId: unconfirmed.body.run.id,
        eventId: randomUUID(),
        status: "completed",
        output: "Unobserved",
      }).status,
    ).toBe(200);
    expect(normal.backend.runs.get(unconfirmed.body.run.id)?.run.status).toBe(
      "failed",
    );
    expect((await normal.history(id)).body.items).toEqual([]);
  });

  it("creates metadata-only Core, validates targets/projects, renames only title and tombstones inactive history", async () => {
    const { app, backend, create, dispatched, send, history } = await setup();
    const id = await create();
    await create({ target: { kind: "workflow", id: "core" } });
    for (const target of [
      { kind: "agent", id: "orchestrator" },
      { kind: "workflow", id: "other" },
    ])
      expect(
        (
          await request(app)
            .post("/api/v1/conversations")
            .set(auth)
            .send({ target })
        ).status,
      ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/v1/conversations")
          .set(auth)
          .send({ projectId: "missing" })
      ).status,
    ).toBe(404);
    await tick();
    expect(dispatched).toEqual([]);
    expect(backend.runs.size).toBe(0);
    const original = (
      await request(app).get(`/api/v1/conversations/${id}`).set(auth)
    ).body;
    const renamed = await request(app)
      .patch(`/api/v1/conversations/${id}`)
      .set(auth)
      .send({
        title: "Renamed",
        projectId: "other",
        target: { kind: "agent", id: "other" },
      });
    expect(renamed.body).toEqual({ ...original, title: "Renamed" });
    const accepted = await send(id);
    expect(accepted.status).toBe(202);
    expect(
      (await request(app).delete(`/api/v1/conversations/${id}`).set(auth)).body
        .error.code,
    ).toBe("conversation_active");
    complete(backend, accepted.body.run.id);
    expect(
      (await request(app).delete(`/api/v1/conversations/${id}`).set(auth))
        .status,
    ).toBe(200);
    expect((await history(id)).status).toBe(404);
    expect(
      (await request(app).get(`/api/v1/conversations/${id}`).set(auth)).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/v1/conversations/${id}`)
          .set(auth)
          .send({ title: "Again" })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/v1/conversations/${id}`).set(auth))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get("/api/v1/conversations").set(auth)).body.items,
    ).toHaveLength(1);
    expect(backend.messages.get(id)).toHaveLength(2);
    expect(backend.runs.has(accepted.body.run.id)).toBe(true);
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${id}/events/stream`)
          .set(auth)
      ).status,
    ).toBe(501);
  });

  it("bootstraps without resume, commits exact provisional message at finalization, resumes strictly and keeps sessions private", async () => {
    const { backend, create, send, history, dispatched } = await setup();
    const id = await create();
    const first = await send(id);
    expect(first.status).toBe(202);
    expect(first.body.run.conversationId).toBe(id);
    expect(first.body.run).not.toHaveProperty("target");
    expect((await history(id)).body.items).toEqual([]);
    await tick();
    expect(dispatched[0].input).toEqual({ text: "New turn" });
    complete(backend, first.body.run.id, { resumed: false, finalize: false });
    expect((await history(id)).body.items).toEqual([]);
    expect(
      backend.finalize({
        runId: first.body.run.id,
        eventId: randomUUID(),
        status: "completed",
        output: "Reply",
      }).status,
    ).toBe(200);
    expect((await history(id)).body.items[0]).toEqual(first.body.message);
    for (const resumed of [false, undefined]) {
      const next = await send(id);
      await tick();
      expect(dispatched.at(-1)!.input).toEqual({
        text: "New turn",
        sessionID: "private-session",
      });
      complete(backend, next.body.run.id, {
        resumed,
        sessionID: "wrong-session",
      });
      expect(backend.runs.get(next.body.run.id)?.run).toMatchObject({
        status: "failed",
        error: { code: "resume_unconfirmed" },
      });
      expect((await history(id)).body.items).toHaveLength(2);
    }
    const next = await send(id);
    await tick();
    expect(dispatched.at(-1)!.input).toEqual({
      text: "New turn",
      sessionID: "private-session",
    });
    complete(backend, next.body.run.id, { resumed: true });
    expect((await history(id)).body.items).toHaveLength(4);
    const publicState = JSON.stringify([
      ...backend.runs.values(),
      ...backend.events.values(),
      ...backend.conversationEvents.values(),
      ...backend.conversations.values(),
      ...backend.messages.values(),
    ]);
    expect(publicState).not.toContain("private-session");
    expect(publicState).not.toContain("sessionID");
    expect(publicState).not.toContain("sourceWorkflowId");
  });

  it("discards failed/cancelled bootstrap and cancellation after terminal before finalization", async () => {
    const { app, backend, create, send, history, dispatched } = await setup();
    for (const mode of ["failed", "cancel", "terminal-cancel"]) {
      const id = await create();
      const accepted = await send(id);
      await tick();
      if (mode === "failed")
        complete(backend, accepted.body.run.id, { status: "failed" });
      else {
        if (mode === "terminal-cancel")
          complete(backend, accepted.body.run.id, { finalize: false });
        expect(
          (
            await request(app)
              .post(`/api/v1/runs/${accepted.body.run.id}/cancel`)
              .set(auth)
              .send({})
          ).status,
        ).toBe(200);
        expect(
          backend.finalize({
            runId: accepted.body.run.id,
            eventId: randomUUID(),
            status: "completed",
            output: "Late",
          }).status,
        ).toBe(409);
      }
      expect((await history(id)).body.items).toEqual([]);
      expect(
        backend.conversationEvents
          .get(id)
          ?.some((event) => event.type === "message.created"),
      ).toBe(false);
      const retry = await send(id);
      expect(retry.status).toBe(202);
      await tick();
      expect(dispatched.at(-1)!.input).toEqual({ text: "New turn" });
      backend.workerFailed(retry.body.run.id);
    }
  });

  it("uses exact current config without replay, guards whole linked workflow and preserves historical output/events", async () => {
    const { app, backend, send, history, dispatched } = await setup();
    const created = await request(app)
      .post("/api/v1/workflows")
      .set(auth)
      .send(workflow());
    const workflowId = created.body.id as string;
    const accepted = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send({
        target: { kind: "workflow", id: workflowId },
        input: { text: "original", upstream: "private" },
      });
    const runId = accepted.body.run.id as string;
    const id = complete(backend, runId, {
      nodeId: "exact-agent",
      finalize: false,
    });
    expect((await send(id)).body.error.code).toBe("conversation_busy");
    expect(
      (await request(app).delete(`/api/v1/conversations/${id}`).set(auth)).body
        .error.code,
    ).toBe("conversation_active");
    backend.finalize({
      runId,
      eventId: randomUUID(),
      status: "completed",
      output: "Historical output",
    });
    const historical = structuredClone([
      backend.runs.get(runId),
      backend.events.get(runId),
    ]);
    await request(app)
      .put(`/api/v1/workflows/${workflowId}`)
      .set(auth)
      .send(
        workflow("agent", {
          model: "v2",
          tools: "current-tools",
          config: "config",
          promptType: "flow",
          invocation: "command",
        }),
      );
    const next = await send(id);
    await tick();
    const payload = dispatched.at(-1)!;
    expect(payload.input).toEqual({
      text: "New turn",
      sessionID: "private-session",
    });
    expect(payload.flows).toHaveLength(4);
    expect(
      payload.flows.find((node) => node.id === "exact-agent"),
    ).toMatchObject({
      type: "agent",
      model: "v2",
      tools: "current-tools",
      config: "config",
      invocation: "prompt",
      prompt: "input.text",
      promptType: "msg",
      sessionIdProp: "input.sessionID",
      sessionIdPropType: "msg",
      x: 250,
      y: 100,
    });
    expect(
      payload.flows.some((node) =>
        ["side-effect", "config", "progress"].includes(String(node.id)),
      ),
    ).toBe(false);
    const agent = payload.flows[2];
    expect(agent.wires).toEqual([[payload.flows[3].id], []]);
    complete(backend, next.body.run.id, {
      nodeId: "exact-agent",
      resumed: true,
    });
    expect([backend.runs.get(runId), backend.events.get(runId)]).toEqual(
      historical,
    );
    const failed = await send(id);
    complete(backend, failed.body.run.id, {
      nodeId: "exact-agent",
      status: "failed",
    });
    expect((await history(id)).body.items).toHaveLength(4);
    for (const type of ["function", "removed"]) {
      const body = workflow(type);
      if (type === "removed") body.specification.flows[3].id = "replacement";
      await request(app)
        .put(`/api/v1/workflows/${workflowId}`)
        .set(auth)
        .send(body);
      const rejected = await send(id);
      expect(rejected.status).toBe(409);
      expect(rejected.body.error.code).toBe("conversation_not_resumable");
    }
    await request(app).delete(`/api/v1/workflows/${workflowId}`).set(auth);
    expect((await send(id)).body.error.code).toBe("conversation_not_resumable");
  });

  it("scopes idempotency by endpoint/conversation and replays immutable acceptance after failure/cancel/deletion", async () => {
    const { app, backend, create, send, dispatched } = await setup();
    const key = "shared-key-51";
    const run = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .set("idempotency-key", key)
      .send({
        target: { kind: "workflow", id: "core" },
        input: { text: "Independent" },
      });
    expect(run.status).toBe(202);
    backend.workerFailed(run.body.run.id);
    for (const mode of ["failed", "cancelled"]) {
      const id = await create();
      const accepted = await send(id, "New turn", key);
      expect(accepted.status).toBe(202);
      expect((await send(id, "New turn", key)).body).toEqual(accepted.body);
      expect((await send(id, "Changed", key)).body.error.code).toBe(
        "idempotency_conflict",
      );
      await tick();
      const count = dispatched.length;
      if (mode === "failed") backend.workerFailed(accepted.body.run.id);
      else
        await request(app)
          .post(`/api/v1/runs/${accepted.body.run.id}/cancel`)
          .set(auth)
          .send({});
      expect((await send(id, "New turn", key)).body).toEqual(accepted.body);
      await request(app).delete(`/api/v1/conversations/${id}`).set(auth);
      expect((await send(id, "New turn", key)).body).toEqual(accepted.body);
      expect((await send(id, "Changed", key)).status).toBe(409);
      await tick();
      expect(dispatched).toHaveLength(count);
    }
  });

  it("rejects structured content before work and uses public project ownership/current cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-project-"));
    try {
      const projects = new Projects(root, join(root, "global"));
      const { app, backend, create, send, dispatched } = await setup(projects);
      const project = await request(app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ name: "Project" });
      const id = await create({ projectId: project.body.id });
      expect(
        (
          await request(app)
            .post(`/api/v1/conversations/${id}/messages`)
            .set(auth)
            .send({ content: [{ type: "text", text: "Unsupported" }] })
        ).status,
      ).toBe(400);
      expect(backend.runs.size).toBe(0);
      const first = await send(id);
      await tick();
      expect(dispatched.at(-1)!.cwd).toBe(project.body.localPath);
      complete(backend, first.body.run.id);
      await request(app)
        .patch(`/api/v1/projects/${project.body.id}`)
        .set(auth)
        .send({ name: "Renamed" });
      const next = await send(id);
      await tick();
      expect(dispatched.at(-1)!.cwd).toBe(project.body.localPath);
      complete(backend, next.body.run.id, { resumed: true });
      const observed = await request(app)
        .post("/api/v1/runs")
        .set(auth)
        .send({
          projectId: project.body.id,
          target: { kind: "workflow", id: "core" },
          input: { text: "Observed" },
        });
      const observedId = complete(backend, observed.body.run.id);
      expect(backend.conversations.get(observedId)?.projectId).toBe(
        project.body.id,
      );
      expect(
        (
          await request(app)
            .get("/api/v1/conversations")
            .query({
              projectId: project.body.id,
              targetKind: "agent",
              targetId: "orchestrator",
            })
            .set(auth)
        ).body.items.map((item: { id: string }) => item.id),
      ).toEqual([observedId]);
      await rm(project.body.localPath as string, { recursive: true });
      const unavailable = await send(id);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error.code).toBe("project_unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
