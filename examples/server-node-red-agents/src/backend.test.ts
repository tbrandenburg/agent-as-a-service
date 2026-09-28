import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend, type Executor } from "./backend.js";

const auth = { authorization: "Bearer test-token" };
const target = { kind: "workflow", workflowId: "node-red-demo" };
const start = (
  text = "Release notes",
  conversationIds?: Record<string, string>,
) => ({
  target,
  input: { text, ...(conversationIds ? { conversationIds } : {}) },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("Node-RED agents HTTP boundary", () => {
  it("reserves both conversations, replays immutable responses and checkpoints before final result", async () => {
    let complete!: (value: {
      runId: string;
      conversationId: string;
      reply: string;
      sessionID: string;
    }) => void;
    let backend!: AgentsBackend;
    let calls = 0;
    let boundaryError: unknown;
    const executor: Executor = async (_path, payload) => {
      calls++;
      try {
        const result = backend.checkpoint({
          runId: payload.runId,
          conversationId: payload.writerId,
          reply: "Writer text",
          sessionID: "writer-session",
          prompt: `Review ${payload.text}: Writer text`,
        });
        expect(result).toEqual({ status: 200, body: { acknowledged: true } });
        expect(
          backend.checkpoint({
            runId: payload.runId,
            conversationId: payload.writerId,
            reply: "Writer text",
            sessionID: "writer-session",
            prompt: `Review ${payload.text}: Writer text`,
          }).status,
        ).toBe(200);
        expect(
          backend.checkpoint({
            runId: payload.runId,
            conversationId: payload.writerId,
            reply: "altered",
            sessionID: "writer-session",
            prompt: "different",
          }).status,
        ).toBe(409);
      } catch (error) {
        boundaryError = error;
        throw error;
      }
      return await new Promise((resolve) => {
        complete = resolve;
      });
    };
    backend = new AgentsBackend(executor);
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const accepted = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .set("Idempotency-Key", "same-key-123")
      .send(start());
    expect(accepted.status).toBe(202);
    const [writer, reviewer] = accepted.body.conversations.map(
      (link: { conversationId: string }) => link.conversationId,
    ) as string[];
    expect(writer).not.toBe(reviewer);
    expect(
      (await request(app).get(`/api/v1/runs/${accepted.body.run.id}`).set(auth))
        .body.conversations,
    ).toEqual(accepted.body.conversations);
    await tick();
    expect(boundaryError).toBeUndefined();
    const replay = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .set("Idempotency-Key", "same-key-123")
      .send({ input: { text: "Release notes" }, target });
    expect(replay.body).toEqual(accepted.body);
    expect(
      (
        await request(app)
          .post("/api/v1/runs")
          .set(auth)
          .set("Idempotency-Key", "same-key-123")
          .send(start("changed"))
      ).body.error.code,
    ).toBe("idempotency_conflict");
    const busy = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send(start("busy", { reviewer }));
    expect(
      (await request(app).get(`/api/v1/runs/${accepted.body.run.id}`).set(auth))
        .body.run.status,
    ).toBe("running");
    expect(busy.body).toMatchObject({ error: { code: "conversation_busy" } });
    expect(backend.conversations.size).toBe(2);
    expect(backend.runs.size).toBe(1);
    expect(calls).toBe(1);
    const writerHistory = await request(app)
      .get(`/api/v1/conversations/${writer}/messages`)
      .set(auth);
    expect(
      writerHistory.body.items.map((item: { role: string }) => item.role),
    ).toEqual(["user", "assistant"]);
    const reviewerHistory = await request(app)
      .get(`/api/v1/conversations/${reviewer}/messages`)
      .set(auth);
    expect(reviewerHistory.body.items).toMatchObject([
      { role: "user", content: "Review Release notes: Writer text" },
    ]);
    complete({
      runId: accepted.body.run.id,
      conversationId: reviewer,
      reply: "Reviewer text",
      sessionID: "reviewer-session",
    });
    await tick();
    expect(
      (await request(app).get(`/api/v1/runs/${accepted.body.run.id}`).set(auth))
        .body.run,
    ).toMatchObject({
      status: "completed",
      output: "Writer: Writer text\nReviewer: Reviewer text",
    });
    expect(
      backend.checkpoint({
        runId: accepted.body.run.id,
        conversationId: writer,
        reply: "late",
        sessionID: "writer-session",
        prompt: "late",
      }).status,
    ).toBe(409);
  });

  it("retains writer after reviewer failure and blocks ambiguous session reuse", async () => {
    let backend!: AgentsBackend;
    const executor: Executor = async (_path, payload) => {
      backend.checkpoint({
        runId: payload.runId,
        conversationId: payload.writerId,
        reply: "Confirmed",
        sessionID: "s1",
        prompt: "Review Confirmed",
      });
      throw new TypeError("network disconnected");
    };
    backend = new AgentsBackend(executor);
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const accepted = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send(start());
    const [writer, reviewer] = accepted.body.conversations.map(
      (link: { conversationId: string }) => link.conversationId,
    ) as string[];
    await tick();
    const failed = await request(app)
      .get(`/api/v1/runs/${accepted.body.run.id}`)
      .set(auth);
    expect(failed.body.run.status).toBe("failed");
    expect(failed.body.conversations).toEqual(accepted.body.conversations);
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${writer}/messages`)
          .set(auth)
      ).body.items,
    ).toHaveLength(2);
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${reviewer}/messages`)
          .set(auth)
      ).body.items,
    ).toHaveLength(1);
    expect(
      (
        await request(app)
          .post(`/api/v1/conversations/${reviewer}/messages`)
          .set(auth)
          .send({ content: "again" })
      ).body.error.code,
    ).toBe("conversation_busy");
    expect(
      (
        await request(app)
          .get(`/api/v1/runs/${accepted.body.run.id}/events?after=1&limit=2`)
          .set(auth)
      ).body.map((event: { sequence: number }) => event.sequence),
    ).toEqual([2, 3]);
  });

  it("rejects invalid ownership and structured content without allocating runs", async () => {
    const backend = new AgentsBackend(async () => {
      throw new Error("should not execute");
    });
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const writer = await request(app)
      .post("/api/v1/conversations")
      .set(auth)
      .send({ agentId: "writer" });
    for (const body of [
      start("bad", { reviewer: writer.body.id }),
      start("bad", { writer: "missing" }),
      { target, input: { text: "okay", extra: true } },
    ])
      expect(
        (await request(app).post("/api/v1/runs").set(auth).send(body)).status,
      ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/v1/conversations/${writer.body.id}/messages`)
          .set(auth)
          .send({ content: [{ type: "text", text: "structured" }] })
      ).body.error.code,
    ).toBe("unsupported_content");
    expect(backend.runs.size).toBe(0);
    expect(backend.conversations.size).toBe(1);
  });

  it("rejects unconfirmed resumed checkpoints and preserves the accepted prompt after an ambiguous writer disconnect", async () => {
    let backend!: AgentsBackend;
    let outcome = 0;
    const executor: Executor = async (_path, payload) => {
      if (outcome++ === 0) {
        expect(
          backend.checkpoint({
            runId: payload.runId,
            conversationId: payload.writerId,
            reply: "first",
            sessionID: "writer-session",
            prompt: "Review first",
          }).status,
        ).toBe(200);
        return {
          runId: payload.runId,
          conversationId: payload.reviewerId!,
          reply: "review",
          sessionID: "reviewer-session",
        };
      }
      expect(payload.writerSession).toBe("writer-session");
      expect(
        backend.checkpoint({
          runId: payload.runId,
          conversationId: payload.writerId,
          reply: "unconfirmed",
          sessionID: "writer-session",
          resumed: false,
          prompt: "Review unconfirmed",
        }).status,
      ).toBe(409);
      throw new TypeError("connection lost");
    };
    backend = new AgentsBackend(executor);
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const first = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send(start());
    const [writer, reviewer] = first.body.conversations.map(
      (link: { conversationId: string }) => link.conversationId,
    ) as string[];
    await tick();
    const second = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send(start("again", { writer, reviewer }));
    expect(second.status).toBe(202);
    await tick();
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${writer}/messages`)
          .set(auth)
      ).body.items.map((item: { role: string }) => item.role),
    ).toEqual(["user", "assistant", "user"]);
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${reviewer}/messages`)
          .set(auth)
      ).body.items,
    ).toHaveLength(2);
    expect(
      (
        await request(app)
          .post("/api/v1/runs")
          .set(auth)
          .send(start("blocked", { writer }))
      ).body.error.code,
    ).toBe("conversation_busy");
    expect(
      backend.checkpoint({
        runId: second.body.run.id,
        conversationId: writer,
        reply: "late",
        sessionID: "writer-session",
        resumed: true,
        prompt: "late",
      }).status,
    ).toBe(409);
  });

  it("paginates filtered reads and replays direct-message acceptance while busy", async () => {
    let complete!: (value: {
      runId: string;
      conversationId: string;
      reply: string;
      sessionID: string;
    }) => void;
    const backend = new AgentsBackend(
      async (_path, payload) =>
        await new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const created = await request(app)
      .post("/api/v1/conversations")
      .set(auth)
      .send({ agentId: "writer" });
    const id = created.body.id as string;
    const accepted = await request(app)
      .post(`/api/v1/conversations/${id}/messages`)
      .set(auth)
      .set("Idempotency-Key", "direct-key-1")
      .send({ content: "hello" });
    expect(accepted.status).toBe(202);
    await tick();
    const replay = await request(app)
      .post(`/api/v1/conversations/${id}/messages`)
      .set(auth)
      .set("Idempotency-Key", "direct-key-1")
      .send({ content: "hello" });
    expect(replay.body).toEqual(accepted.body);
    expect(
      (
        await request(app)
          .post(`/api/v1/conversations/${id}/messages`)
          .set(auth)
          .set("Idempotency-Key", "direct-key-1")
          .send({ content: "different" })
      ).body.error.code,
    ).toBe("idempotency_conflict");
    expect(
      (
        await request(app)
          .get("/api/v1/runs?targetKind=agent&conversationId=" + id)
          .set(auth)
      ).body.items,
    ).toHaveLength(1);
    expect(
      (
        await request(app)
          .get("/api/v1/conversations?agentId=reviewer")
          .set(auth)
      ).body.items,
    ).toHaveLength(0);
    complete({
      runId: accepted.body.run.id,
      conversationId: id,
      reply: "answer",
      sessionID: "session",
    });
    await tick();
    const page = await request(app)
      .get(`/api/v1/conversations/${id}/messages?limit=1`)
      .set(auth);
    expect(page.body.items).toHaveLength(1);
    expect(
      (
        await request(app)
          .get(
            `/api/v1/conversations/${id}/messages?limit=1&cursor=${page.body.nextCursor}`,
          )
          .set(auth)
      ).body.items,
    ).toMatchObject([{ role: "assistant" }]);
  });

  it("blocks writer when workflow transport fails without an acknowledged checkpoint", async () => {
    const backend = new AgentsBackend(async () => {
      throw new DOMException("Transport timeout", "TimeoutError");
    });
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const accepted = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send(start());
    const [writer, reviewer] = accepted.body.conversations.map(
      (link: { conversationId: string }) => link.conversationId,
    ) as string[];
    await tick();
    expect(
      (await request(app).get(`/api/v1/runs/${accepted.body.run.id}`).set(auth))
        .body.run.status,
    ).toBe("failed");
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${writer}/messages`)
          .set(auth)
      ).body.items,
    ).toMatchObject([{ role: "user" }]);
    expect(
      (
        await request(app)
          .post("/api/v1/runs")
          .set(auth)
          .send(start("retry", { writer }))
      ).body.error.code,
    ).toBe("conversation_busy");
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${reviewer}/messages`)
          .set(auth)
      ).body.items,
    ).toHaveLength(0);
  });

  it("blocks reviewer reuse when a successful private HTTP response has an unconfirmed result", async () => {
    let backend!: AgentsBackend;
    const executor: Executor = async (_path, payload) => {
      expect(
        backend.checkpoint({
          runId: payload.runId,
          conversationId: payload.writerId,
          reply: "Writer text",
          sessionID: "writer-session",
          prompt: "Review Writer text",
        }).status,
      ).toBe(200);
      return {
        runId: payload.runId,
        conversationId: payload.reviewerId!,
        reply: "Reviewer text",
        sessionID: "",
      };
    };
    backend = new AgentsBackend(executor);
    const app = createApp({
      token: "test-token",
      implementation: backend.implementation(),
    });
    const accepted = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send(start());
    const [writer, reviewer] = accepted.body.conversations.map(
      (link: { conversationId: string }) => link.conversationId,
    ) as string[];
    await tick();
    expect(
      (await request(app).get(`/api/v1/runs/${accepted.body.run.id}`).set(auth))
        .body.run.status,
    ).toBe("failed");
    expect(
      (
        await request(app)
          .post("/api/v1/runs")
          .set(auth)
          .send(start("again", { reviewer }))
      ).body.error.code,
    ).toBe("conversation_busy");
    expect(
      (
        await request(app)
          .get(`/api/v1/conversations/${writer}/messages`)
          .set(auth)
      ).body.items,
    ).toHaveLength(2);
  });
});
