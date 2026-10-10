import assert from "node:assert/strict";
import { multiply } from "./native-fixtures.js";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error("DEMO_BASE_URL and API_TOKEN required");

async function request(
  path: string,
  method: string,
  expected: number,
  body?: unknown,
) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, expected, `${method} ${path}`);
  return response.json() as Promise<Record<string, unknown>>;
}

await request("/health", "GET", 200);
const workflow = await request("/workflows", "POST", 201, multiply);
assert.equal(typeof workflow.id, "string");
const accepted = await request("/runs", "POST", 202, {
  target: { kind: "workflow", id: workflow.id },
  input: { a: 13.75, b: -8 },
});
const run = accepted.run as { id?: unknown };
assert.equal(typeof run.id, "string");

const deadline = Date.now() + 60_000;
let completed = false;
while (Date.now() < deadline) {
  const detail = await request(`/runs/${run.id}`, "GET", 200);
  const result = detail.run as { status?: unknown; output?: unknown };
  if (result.status === "completed") {
    assert.equal(typeof result.output, "number");
    assert.equal(result.output, -110);
    console.log("Published-package native multiplication passed: number -110");
    await request(`/workflows/${workflow.id}`, "DELETE", 200);
    completed = true;
    break;
  }
  assert.notEqual(result.status, "failed", "native multiplication failed");
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!completed) throw new Error("Native multiplication timed out");
