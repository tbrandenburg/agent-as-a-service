import { describe, expect, it } from "vitest";
import { createTestApp as createApp } from "./test-app.js";
import { createDemoImplementation } from "./adapters/demo.js";

const auth = { authorization: "Bearer demo-test" };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("in-memory demo lifecycle", () => {
  it("executes the provider through HTTP and resumes its conversation session", async () => {
    const app = createApp({
      token: "demo-test",
      implementation: createDemoImplementation(),
    });
    const send = (conversationId: string, content: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/conversations/${conversationId}/messages`,
        headers: auth,
        payload: { content },
      });
    const finished = async (runId: string) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/runs/${runId}`,
          headers: auth,
        });
        if (response.json().run.status === "completed") return;
        await wait(20);
      }
      throw new Error("Demo agent did not finish");
    };
    try {
      const conversation = await app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: auth,
        payload: {},
      });
      const conversationId = conversation.json().id as string;
      const first = await send(conversationId, "Review this change");
      expect(first.statusCode).toBe(202);
      await finished(first.json().run.id);
      const second = await send(conversationId, "Continue");
      await finished(second.json().run.id);
      const messages = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}/messages`,
        headers: auth,
      });
      expect(
        messages.json().items.map((item: { role: string }) => item.role),
      ).toEqual(["user", "assistant", "user", "assistant"]);
      expect(messages.json().items[3].content).toContain(
        "Continuing our conversation",
      );
      const events = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${second.json().run.id}/events?after=0`,
        headers: auth,
      });
      expect(events.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "agent.session",
            data: { resumed: true },
          }),
          expect.objectContaining({ type: "agent.assistant" }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it("tracks chat, idempotency, approval, events and artifacts over HTTP", async () => {
    const app = createApp({
      token: "demo-test",
      implementation: createDemoImplementation(),
    });
    try {
      const request = (
        method: "GET" | "POST",
        url: string,
        payload?: object,
        key?: string,
      ) =>
        app.inject({
          method,
          url,
          headers: { ...auth, ...(key ? { "idempotency-key": key } : {}) },
          payload,
        });

      expect(
        (await app.inject({ method: "GET", url: "/api/v1/projects" }))
          .statusCode,
      ).toBe(401);
      const project = await request("POST", "/api/v1/projects", {
        name: "Demo",
      });
      expect(project.statusCode).toBe(201);
      const projectId = project.json().id as string;
      const conversation = await request("POST", "/api/v1/conversations", {
        projectId,
      });
      expect(conversation.statusCode).toBe(201);
      const conversationId = conversation.json().id as string;

      const url = `/api/v1/conversations/${conversationId}/messages`;
      const sent = await request(
        "POST",
        url,
        { content: "Review this" },
        "same-message-key",
      );
      expect(sent.statusCode).toBe(202);
      const chatRunId = sent.json().run.id as string;
      expect(
        (await request("GET", `/api/v1/runs/${chatRunId}`)).statusCode,
      ).toBe(200);
      const replay = await request(
        "POST",
        url,
        { content: "Review this" },
        "same-message-key",
      );
      expect(replay.json().run.id).toBe(chatRunId);
      expect(
        (
          await request(
            "POST",
            url,
            { content: "Different" },
            "same-message-key",
          )
        ).statusCode,
      ).toBe(409);

      const workflow = await request(
        "POST",
        "/api/v1/runs",
        {
          target: { kind: "workflow", workflowId: "review-demo" },
          projectId,
          conversationId,
          input: "Check the change",
        },
        "workflow-key-001",
      );
      expect(workflow.statusCode).toBe(202);
      const runId = workflow.json().run.id as string;
      expect((await request("GET", `/api/v1/runs/${runId}`)).statusCode).toBe(
        200,
      );
      let interactionId = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        const pending = await request(
          "GET",
          `/api/v1/interactions?projectId=${projectId}`,
        );
        interactionId = pending.json().items[0]?.id ?? "";
        if (interactionId) break;
        await wait(20);
      }
      expect(interactionId).not.toBe("");
      const decisionUrl = `/api/v1/interactions/${interactionId}/decisions`;
      const decided = await request(
        "POST",
        decisionUrl,
        { decision: "approve" },
        "approval-key-001",
      );
      expect(decided.statusCode).toBe(200);
      expect(
        (
          await request(
            "POST",
            decisionUrl,
            { decision: "approve" },
            "approval-key-001",
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await request("POST", decisionUrl, { decision: "approve" }))
          .statusCode,
      ).toBe(409);

      let finished = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const run = await request("GET", `/api/v1/runs/${runId}`);
        if (run.json().run.status === "completed") {
          finished = true;
          break;
        }
        await wait(20);
      }
      expect(finished).toBe(true);
      const messages = await request(
        "GET",
        `/api/v1/conversations/${conversationId}/messages`,
      );
      expect(
        messages.json().items.map((item: { role: string }) => item.role),
      ).toEqual(["user", "assistant"]);
      const events = await request(
        "GET",
        `/api/v1/runs/${runId}/events?after=0`,
      );
      expect(
        events.json().map((item: { sequence: number }) => item.sequence),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const artifacts = await request("GET", `/api/v1/runs/${runId}/artifacts`);
      const artifactId = artifacts.json()[0].id as string;
      const report = await request(
        "GET",
        `/api/v1/runs/${runId}/artifacts/${artifactId}`,
      );
      expect(
        Buffer.from(report.json().contentBase64, "base64").toString("utf8"),
      ).toContain("simulated review");
    } finally {
      await app.close();
    }
  });
});
