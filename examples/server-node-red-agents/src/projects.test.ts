import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend } from "./backend.js";
import { Projects } from "./projects.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "aaas-project-test-"));
  roots.push(root);
  const projects = new Projects(join(root, "projects"), join(root, "global"));
  const calls: {
    runId: string;
    cwd?: string;
    flows: Record<string, unknown>[];
  }[] = [];
  const backend = new AgentsBackend(
    async (payload) => {
      calls.push(payload);
    },
    undefined,
    projects,
  );
  await backend.initialize();
  const app = createApp({
    token: "test-token",
    implementation: backend.implementation(),
  });
  const auth = { authorization: "Bearer test-token" };
  return { root, projects, calls, backend, app, auth };
}

describe("project directory registry and run acceptance", () => {
  it("creates, pages, renames, restarts and retains files on deletion", async () => {
    const { root, projects, app, auth } = await setup();
    const empty = await request(app)
      .post("/api/v1/projects")
      .set(auth)
      .send({
        name: "first",
        folderName: "my-folder",
        provisioning: { kind: "empty" },
      });
    expect(empty.status).toBe(201);
    expect(empty.body.localPath).toBe(join(root, "projects", "my-folder"));
    expect(await readdir(empty.body.localPath)).toEqual([]);
    await mkdir(join(root, "projects", "previous"));
    const existing = await request(app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ localPath: join(root, "projects", "previous") });
    expect(existing.status).toBe(201);
    const firstPage = await request(app)
      .get("/api/v1/projects?limit=1")
      .set(auth);
    expect(firstPage.body.items.map((item: { id: string }) => item.id)).toEqual(
      [empty.body.id],
    );
    const secondPage = await request(app)
      .get(`/api/v1/projects?limit=1&cursor=${firstPage.body.nextCursor}`)
      .set(auth);
    expect(secondPage.body.items[0].id).toBe(existing.body.id);
    expect(secondPage.body.nextCursor).toBeNull();
    const renamed = await request(app)
      .patch(`/api/v1/projects/${empty.body.id}`)
      .set(auth)
      .send({ name: "renamed" });
    expect(renamed.body).toMatchObject({
      name: "renamed",
      localPath: empty.body.localPath,
    });
    const loaded = new Projects(projects.root, projects.global);
    await loaded.initialize();
    expect(loaded.get(empty.body.id)).toMatchObject(renamed.body);
    expect(await loaded.cwd(empty.body.id)).toBe(empty.body.localPath);
    expect(
      (await request(app).delete(`/api/v1/projects/${empty.body.id}`).set(auth))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get(`/api/v1/projects/${empty.body.id}`).set(auth))
        .status,
    ).toBe(404);
    expect(await readdir(empty.body.localPath)).toEqual([]);
  });

  it("rejects collisions, escaping symlinks, missing paths, invalid URLs and failed clones without registering", async () => {
    const { root, app, auth } = await setup();
    const create = (body: Record<string, unknown>) =>
      request(app).post("/api/v1/projects").set(auth).send(body);
    await mkdir(join(root, "projects", "busy"));
    await symlink(root, join(root, "projects", "escape"));
    expect((await create({ folderName: "busy" })).status).toBe(409);
    expect((await create({ folderName: "../escape" })).status).toBe(400);
    expect(
      (await create({ localPath: join(root, "projects", "escape") })).status,
    ).toBe(400);
    expect(
      (await create({ localPath: join(root, "projects", "missing") })).status,
    ).toBe(404);
    expect(
      (
        await create({
          provisioning: {
            kind: "clone",
            repositoryUrl: "https://example.com/repo",
          },
          folderName: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create({
          provisioning: {
            kind: "clone",
            repositoryUrl:
              "https://github.com/aaas-no-such-org/aaas-no-such-repo.git",
          },
          folderName: "failed",
        })
      ).status,
    ).toBe(503);
    expect(
      (await request(app).get("/api/v1/projects").set(auth)).body.items,
    ).toEqual([]);
    expect(await readdir(join(root, "projects"))).toEqual(["busy", "escape"]);
  }, 90_000);

  it("selects explicit project for overlapping runs and guards deletion while active", async () => {
    const { projects, app, auth, calls, backend } = await setup();
    const created = await request(app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ folderName: "shared" });
    const id = created.body.id as string;
    const start = (projectId?: string) =>
      request(app)
        .post("/api/v1/runs")
        .set(auth)
        .send({
          ...(projectId ? { projectId } : {}),
          target: { kind: "workflow", id: "core" },
          input: { text: "test" },
        });
    const [a, b, global] = await Promise.all([start(id), start(id), start()]);
    expect([a.status, b.status, global.status]).toEqual([202, 202, 202]);
    expect(a.body.run.id).not.toBe(b.body.run.id);
    expect([
      a.body.run.projectId,
      b.body.run.projectId,
      global.body.run.projectId,
    ]).toEqual([id, id, null]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.map((call) => call.cwd)).toEqual([
      created.body.localPath,
      created.body.localPath,
      projects.global,
    ]);
    for (const call of calls) {
      expect(
        call.flows.find((node) => node.id === "orchestrator"),
      ).toMatchObject({
        model: "DEFAULT_MODEL",
        modelType: "env",
      });
    }
    expect(
      (await request(app).delete(`/api/v1/projects/${id}`).set(auth)).status,
    ).toBe(409);
    backend.workerFailed(a.body.run.id);
    backend.workerFailed(b.body.run.id);
    expect(
      (await request(app).delete(`/api/v1/projects/${id}`).set(auth)).status,
    ).toBe(200);
    expect((await start(id)).status).toBe(404);
    expect(
      (await request(app).get(`/api/v1/runs/${a.body.run.id}`).set(auth)).body
        .run.projectId,
    ).toBe(id);
    expect(await readdir(created.body.localPath)).toEqual([]);
  });

  it("captures Core conversation and session observations and rejects continuation without dispatch", async () => {
    const { app, auth, backend, calls } = await setup();
    const start = async (conversationId?: string) =>
      request(app)
        .post("/api/v1/runs")
        .set(auth)
        .send({
          target: { kind: "workflow", id: "core" },
          input: { text: "Continue" },
          ...(conversationId ? { conversationId } : {}),
        });
    const initial = await start();
    expect(initial.status).toBe(202);
    const observation = (
      id: string,
      type: string,
      executionId: string,
      deploymentId: string,
      extras: Record<string, unknown> = {},
    ) => ({
      version: 1,
      type,
      eventId: `${type}-${executionId}`,
      timestamp: new Date().toISOString(),
      nodeId: "orchestrator",
      deploymentId,
      agent: "opencode",
      agentName: "orchestrator",
      executionId,
      agentObservation: { runId: id },
      input: { invocation: "prompt", prompt: "Continue" },
      ...extras,
    });
    const firstStart = observation(
      initial.body.run.id,
      "execution.started",
      "exec-initial",
      "deploy-initial",
    );
    const id = backend.observe(firstStart).body.conversationId!;
    expect(
      backend.observe(
        observation(
          initial.body.run.id,
          "execution.terminal",
          "exec-initial",
          "deploy-initial",
          {
            status: "completed",
            output: { payload: "First" },
            sessionID: "provider-session",
          },
        ),
      ).status,
    ).toBe(200);
    expect(
      backend.finalize({
        runId: initial.body.run.id,
        eventId: "initial-final",
        status: "completed",
        output: "First",
      }).status,
    ).toBe(200);
    const resumed = await start(id);
    expect(resumed.status).toBe(501);
    expect(resumed.body.error.code).toBe(
      "conversation_continuation_unsupported",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    const messages = await request(app)
      .get(`/api/v1/conversations/${id}/messages`)
      .set(auth);
    expect(
      messages.body.items.map((message: { role: string }) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(
      (await request(app).get(`/api/v1/runs/${initial.body.run.id}`).set(auth))
        .body.conversations,
    ).toEqual([{ conversationId: id, nodeId: "orchestrator" }]);
  });

  it("rejects conversationId even with a different explicit project before accepting a run", async () => {
    const { app, auth, backend } = await setup();
    const initial = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send({
        target: { kind: "workflow", id: "core" },
        input: { text: "First" },
      });
    expect(initial.status).toBe(202);
    const runId = initial.body.run.id as string;
    const started = {
      version: 1,
      type: "execution.started",
      eventId: "first-start",
      timestamp: new Date().toISOString(),
      nodeId: "orchestrator",
      deploymentId: "first-deployment",
      agent: "opencode",
      agentName: "orchestrator",
      executionId: "first-execution",
      agentObservation: { runId },
      input: { invocation: "prompt", prompt: "First" },
    };
    const conversationId = backend.observe(started).body.conversationId!;
    expect(
      backend.observe({
        ...started,
        type: "execution.terminal",
        eventId: "first-terminal",
        status: "completed",
        output: { payload: "First response" },
        sessionID: "provider-session",
      }).status,
    ).toBe(200);
    backend.finalize({
      runId,
      eventId: "first-final",
      status: "completed",
      output: "First response",
    });
    const project = await request(app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ folderName: "different" });
    expect(project.status).toBe(201);
    const resumed = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send({
        target: { kind: "workflow", id: "core" },
        input: { text: "Continue" },
        conversationId,
        projectId: project.body.id,
      });
    expect(resumed.status).toBe(501);
    expect(resumed.body.error.code).toBe(
      "conversation_continuation_unsupported",
    );
    expect(backend.runs.size).toBe(1);
  });
});
