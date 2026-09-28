import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server-express/src/index.js";
import { NodeRedBackend } from "./implementation.js";

const app = createApp({
  token: "test-token",
  implementation: new NodeRedBackend("http://127.0.0.1:0").implementation(),
});
const auth = { authorization: "Bearer test-token" };
const target = { kind: "workflow", workflowId: "node-red-demo" };

describe("Node-RED contract adapter", () => {
  it("validates fixed definitions and rejects unsupported operations without contacting the engine", async () => {
    const list = await request(app).get("/api/v1/workflows").set(auth);
    expect(list.status).toBe(200);
    expect(list.body.items).toMatchObject([
      { id: "node-red-demo", engine: "node-red", readOnly: true },
    ]);
    const valid = await request(app)
      .post("/api/v1/workflows/validate")
      .set(auth)
      .send({
        engine: "node-red",
        specificationVersion: "5.x",
        specification: { endpoint: "/workflow/demo" },
      });
    expect(valid.body).toEqual({ valid: true, errors: [] });
    const invalid = await request(app)
      .post("/api/v1/workflows/validate")
      .set(auth)
      .send({
        engine: "other",
        specificationVersion: "5.x",
        specification: {},
      });
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.errors).toHaveLength(2);
    expect(
      (
        await request(app)
          .post("/api/v1/workflows")
          .set(auth)
          .send({ specification: {} })
      ).body.error.code,
    ).toBe("not_implemented");
    expect(
      (
        await request(app)
          .post("/api/v1/runs")
          .set(auth)
          .send({ target, input: { text: "" } })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/v1/runs")
          .set(auth)
          .send({
            target: { kind: "workflow", workflowId: "missing" },
            input: { text: "hello" },
          })
      ).status,
    ).toBe(404);
  });

  it("accepts a run immediately, then records a normal failed lifecycle when Node-RED is unreachable", async () => {
    const accepted = await request(app)
      .post("/api/v1/runs")
      .set(auth)
      .send({ target, input: { text: "hello" } });
    expect(accepted.status).toBe(202);
    expect(accepted.body.run.status).toBe("queued");
    const id = accepted.body.run.id as string;
    const immediate = await request(app).get(`/api/v1/runs/${id}`).set(auth);
    expect(immediate.status).toBe(200);
    let final = immediate;
    for (
      let attempt = 0;
      attempt < 30 && final.body.run.status !== "failed";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      final = await request(app).get(`/api/v1/runs/${id}`).set(auth);
    }
    expect(final.body.run).toMatchObject({
      status: "failed",
      error: { code: "workflow_failed" },
    });
    const events = await request(app)
      .get(`/api/v1/runs/${id}/events`)
      .set(auth);
    expect(
      events.body.map(
        (event: { data: { status: string } }) => event.data.status,
      ),
    ).toEqual(["queued", "running", "failed"]);
    expect(
      events.body.map((event: { sequence: number }) => event.sequence),
    ).toEqual([1, 2, 3]);
    const cursor = await request(app)
      .get(`/api/v1/runs/${id}/events?after=1&limit=1`)
      .set(auth);
    expect(cursor.body).toMatchObject([{ sequence: 2 }]);
  });
});
