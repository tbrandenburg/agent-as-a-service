import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { createBackend } from "./backend.js";

const { generateText, openai } = vi.hoisted(() => ({
  generateText: vi.fn(),
  openai: vi.fn((modelId: string) => ({ provider: "openai", modelId })),
}));

vi.mock("ai", () => ({ generateText }));
vi.mock("@ai-sdk/openai", () => ({ openai }));

const token = "test-token";
const validBody = {
  target: { kind: "agent", id: "openai/gpt-6-luna" },
  input: "Say hello",
};
const app = () => createApp({ token, implementation: createBackend() });
const auth = { Authorization: `Bearer ${token}` };

describe("Vercel AI SDK HTTP backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateText.mockResolvedValue({
      text: "Hello from Luna",
      finishReason: "stop",
    });
  });

  it("generates exactly once and returns a completed run readable by GET", async () => {
    const server = app();
    const post = await request(server)
      .post("/api/v1/runs")
      .set(auth)
      .send(validBody);

    expect(post.status).toBe(202);
    expect(post.body.run).toMatchObject({
      target: validBody.target,
      input: validBody.input,
      output: "Hello from Luna",
      status: "completed",
    });
    expect(post.body.run.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Date(post.body.run.createdAt).toISOString()).toBe(
      post.body.run.createdAt,
    );
    expect(new Date(post.body.run.updatedAt).toISOString()).toBe(
      post.body.run.updatedAt,
    );
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(openai).toHaveBeenCalledExactlyOnceWith("gpt-6-luna");
    expect(generateText).toHaveBeenCalledWith({
      model: { provider: "openai", modelId: "gpt-6-luna" },
      prompt: validBody.input,
      maxRetries: 0,
      maxOutputTokens: 1024,
      timeout: 90_000,
    });

    const get = await request(server)
      .get(`/api/v1/runs/${post.body.run.id}`)
      .set(auth);
    expect(get.status).toBe(200);
    expect(get.body.run).toEqual(post.body.run);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty text", { text: "", finishReason: "stop" }],
    ["whitespace text", { text: "  \n", finishReason: "stop" }],
    ["truncated result", { text: "partial", finishReason: "length" }],
    ["filtered result", { text: "filtered", finishReason: "content-filter" }],
  ])("does not save a completed run for %s", async (_name, result) => {
    generateText.mockResolvedValue(result);
    const server = app();
    const post = await request(server)
      .post("/api/v1/runs")
      .set(auth)
      .send(validBody);
    expect(post.status).toBe(503);
    expect(post.body.error).toMatchObject({ code: "provider_unavailable" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("sanitizes provider rejections and leaves no readable run", async () => {
    generateText.mockRejectedValue(
      new Error("secret internal timeout response"),
    );
    const server = app();
    const post = await request(server)
      .post("/api/v1/runs")
      .set(auth)
      .send(validBody);
    expect(post.status).toBe(503);
    expect(JSON.stringify(post.body)).not.toContain(
      "secret internal timeout response",
    );
    const get = await request(server)
      .get("/api/v1/runs/00000000-0000-4000-8000-000000000000")
      .set(auth);
    expect(get.status).toBe(404);
  });

  it.each([
    ["missing", { ...validBody, input: undefined }, 400],
    ["blank", { ...validBody, input: " \n " }, 400],
    ["oversized", { ...validBody, input: "x".repeat(4097) }, 400],
    [
      "oversized whitespace padding",
      { ...validBody, input: `Say hello${" ".repeat(4096)}` },
      400,
    ],
    ["non-string", { ...validBody, input: { text: "hello" } }, 400],
    [
      "wrong kind",
      { ...validBody, target: { kind: "workflow", id: "openai/gpt-6-luna" } },
      400,
    ],
    [
      "wrong model",
      { ...validBody, target: { kind: "agent", id: "other" } },
      400,
    ],
    [
      "project",
      { ...validBody, projectId: "00000000-0000-4000-8000-000000000000" },
      501,
    ],
    [
      "conversation",
      { ...validBody, conversationId: "00000000-0000-4000-8000-000000000000" },
      501,
    ],
    ["engine options", { ...validBody, engineOptions: {} }, 501],
  ])("rejects %s before the provider call", async (_name, body, status) => {
    const post = await request(app()).post("/api/v1/runs").set(auth).send(body);
    expect(post.status).toBe(status);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("rejects a schema-valid Idempotency-Key before generation", async () => {
    const post = await request(app())
      .post("/api/v1/runs")
      .set({ ...auth, "Idempotency-Key": "smoke-retry-123" })
      .send(validBody);
    expect(post.status).toBe(501);
    expect(post.body.error.code).toBe("not_implemented");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("keeps shared public health/OpenAPI, auth, and typed 501 routes", async () => {
    const server = app();
    expect((await request(server).get("/api/v1/health")).status).toBe(200);
    expect((await request(server).get("/api/v1/openapi.json")).status).toBe(
      200,
    );
    expect(
      (await request(server).post("/api/v1/runs").send(validBody)).status,
    ).toBe(401);
    const unsupported = await request(server).get("/api/v1/projects").set(auth);
    expect(unsupported.status).toBe(501);
    expect(unsupported.body.error.code).toBe("not_implemented");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns typed 404 for an unknown run", async () => {
    const response = await request(app())
      .get("/api/v1/runs/00000000-0000-4000-8000-000000000000")
      .set(auth);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
    expect(generateText).not.toHaveBeenCalled();
  });
});
