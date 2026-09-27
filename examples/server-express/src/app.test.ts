import { describe, it, expect } from "vitest";
import { createTestApp as createApp } from "./test-app.js";
import { notImplementedRoutes } from "./adapters/not-implemented.js";
const token = { authorization: "Bearer dev-test" };
const id = "00000000-0000-4000-8000-000000000001";
describe("exchangeable contract server", () => {
  it("accepts a different typed backend implementation", async () => {
    const app = createApp({
      token: "dev-test",
      implementation: {
        ...notImplementedRoutes,
        projects: {
          ...notImplementedRoutes.projects,
          listProjects: async () => ({
            status: 200 as const,
            body: { items: [], nextCursor: null },
          }),
        },
        workflows: {
          ...notImplementedRoutes.workflows,
          listWorkflows: async () => ({
            status: 200 as const,
            body: {
              items: [
                {
                  id: "builtin-review",
                  name: "Review",
                  specification: "Review this",
                  version: 1,
                  readOnly: true,
                  createdAt: "2026-01-01T00:00:00Z",
                },
              ],
              nextCursor: null,
            },
          }),
        },
      },
    });
    try {
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: token,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ items: [], nextCursor: null });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/workflows",
            headers: token,
          })
        ).json().items[0].readOnly,
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
  it("validates typed query inputs and backend responses", async () => {
    const app = createApp({
      token: "dev-test",
      implementation: {
        ...notImplementedRoutes,
        projects: {
          ...notImplementedRoutes.projects,
          listProjects: async ({ query }) => ({
            status: 200 as const,
            body:
              query.limit === 3
                ? { items: [], nextCursor: null }
                : ({ items: "invalid", nextCursor: null } as unknown as {
                    items: [];
                    nextCursor: null;
                  }),
          }),
        },
      },
    });
    try {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/projects?limit=no",
            headers: token,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/projects?limit=3",
            headers: token,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/projects?limit=4",
            headers: token,
          })
        ).statusCode,
      ).toBe(500);
    } finally {
      await app.close();
    }
  });
  it("serves public health and the generated OpenAPI document", async () => {
    const app = createApp({ token: "dev-test" });
    try {
      await app.ready();
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode,
      ).toBe(200);
      const doc = await app.inject({
        method: "GET",
        url: "/api/v1/openapi.json",
      });
      expect(doc.statusCode).toBe(200);
      const paths = doc.json().paths as Record<string, unknown>;
      expect(paths["/api/v1/projects"]).toBeDefined();
      expect(paths["/api/v1/workflows"]).toBeDefined();
      expect(
        paths["/api/v1/interactions/{interactionId}/decisions"],
      ).toBeDefined();
      expect(paths["/api/v1/interactions"]).toBeDefined();
      expect(paths["/api/v1/runs/{runId}/events/stream"]).toBeDefined();
      expect(
        paths["/api/v1/conversations/{conversationId}/events/stream"],
      ).toBeDefined();
      expect(paths["/api/v1/status"]).toBeDefined();
      expect(
        (paths["/api/v1/status"] as { get: { security?: unknown[] } }).get
          .security,
      ).not.toEqual([]);
    } finally {
      await app.close();
    }
  });
  it("validates requests and authentication before delegating to the backend", async () => {
    const app = createApp({ token: "dev-test" });
    try {
      await app.ready();
      const request = (
        method: "GET" | "POST",
        url: string,
        payload?: Record<string, unknown>,
        headers: Record<string, string> = token,
      ) =>
        app.inject({
          method,
          url,
          headers,
          ...(payload === undefined ? {} : { payload }),
        });
      expect((await request("GET", "/api/v1/projects")).statusCode).toBe(501);
      const unauthorized = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.headers["www-authenticate"]).toBe(
        'Bearer realm="agent-as-a-service"',
      );
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode,
      ).toBe(401);
      const status = await request("GET", "/api/v1/status");
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({
        environment: ["HOST", "PORT", "API_TOKEN"].map((name) => ({
          name,
          set: process.env[name] !== undefined,
        })),
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/runs/${id}/events/stream`,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/conversations/${id}/events/stream`,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await request("POST", "/api/v1/projects", { name: "" })).statusCode,
      ).toBe(400);
      const oversized = await request(
        "POST",
        `/api/v1/conversations/${id}/messages`,
        {
          content: "x".repeat(1_100_000),
        },
      );
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json().error.code).toBe("payload_too_large");
      expect(
        (await request("POST", "/api/v1/projects", { name: "example" }))
          .statusCode,
      ).toBe(501);
      expect((await request("POST", "/api/v1/projects", {})).statusCode).toBe(
        501,
      );
      expect(
        (await request("POST", "/api/v1/projects", { localPath: "/work/repo" }))
          .statusCode,
      ).toBe(501);
      expect(
        (await request("POST", "/api/v1/conversations", {})).statusCode,
      ).toBe(501);
      expect(
        (
          await request("POST", "/api/v1/workflows/validate", {
            name: "test",
            engine: "example",
            specificationVersion: "1",
            specification: {},
          })
        ).statusCode,
      ).toBe(501);
      expect(
        (await request("POST", "/api/v1/workflows", { specification: {} }))
          .statusCode,
      ).toBe(501);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/workflows/workflow-1",
            headers: token,
            payload: { specification: {} },
          })
        ).statusCode,
      ).toBe(501);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/workflows/workflow-1",
            headers: { ...token, "if-match": "v1" },
            payload: { specification: {} },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/workflows/workflow-1",
            headers: { ...token, "if-match": '"v1"' },
            payload: { specification: {} },
          })
        ).statusCode,
      ).toBe(501);
      expect(
        (await request("GET", `/api/v1/runs/${id}/events`)).statusCode,
      ).toBe(501);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/runs/${id}/events/stream`,
            headers: { ...token, "last-event-id": "3" },
          })
        ).statusCode,
      ).toBe(501);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/runs/${id}/events/stream`,
            headers: { ...token, "last-event-id": "invalid" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/conversations/${id}/events/stream`,
            headers: { ...token, "last-event-id": "3" },
          })
        ).statusCode,
      ).toBe(501);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/conversations/${id}/events/stream`,
            headers: { ...token, "last-event-id": "invalid" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await request("GET", `/api/v1/runs/${id}/artifacts`)).statusCode,
      ).toBe(501);
      expect((await request("GET", "/api/v1/interactions")).statusCode).toBe(
        501,
      );
      expect(
        (
          await request(
            "POST",
            "/api/v1/runs",
            { input: "" },
            { ...token, "idempotency-key": "run-key-001" },
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await request(
            "POST",
            "/api/v1/runs",
            { input: "Hello" },
            { ...token, "idempotency-key": "run-key-001" },
          )
        ).statusCode,
      ).toBe(501);
      expect((await request("POST", "/api/v1/runs", {})).statusCode).toBe(501);
      expect(
        (await request("POST", "/api/v1/runs", { input: "Hello" })).statusCode,
      ).toBe(501);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/runs/${id}/resume`,
            headers: token,
          })
        ).statusCode,
      ).toBe(501);
      expect(
        (await request("POST", "/api/v1/conversations", {})).statusCode,
      ).toBe(501);
      expect(
        (
          await request(
            "POST",
            `/api/v1/conversations/${id}/messages`,
            { content: [{ type: "text", text: "Hi" }] },
            { ...token, "idempotency-key": "message-key-001" },
          )
        ).statusCode,
      ).toBe(501);
      expect(
        (
          await request("POST", `/api/v1/interactions/${id}/decisions`, {
            decision: "approve",
          })
        ).statusCode,
      ).toBe(501);
      expect(
        (
          await request("POST", `/api/v1/conversations/${id}/messages`, {
            content: "Hi",
          })
        ).statusCode,
      ).toBe(501);
    } finally {
      await app.close();
    }
  });
});
