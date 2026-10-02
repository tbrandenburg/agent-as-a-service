import assert from "node:assert/strict";
import { createClient, startRun } from "../../client/src/index.js";
import { echo, multiply } from "./native-fixtures.js";
import { runControlAcceptance } from "./run-control-demo.js";
import type { Input } from "./native.js";
import type { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error("DEMO_BASE_URL and API_TOKEN required");
const api = createClient(base, token);
const request = async (
  path: string,
  method: string,
  status: number,
  body?: unknown,
  match?: string,
) => {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(match ? { "if-match": match } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, status, `${method} ${path}`);
  console.log(
    `${method} ${path}: ${response.status} ETag=${response.headers.get("etag") ?? "-"}`,
  );
  return { body: await response.json(), etag: response.headers.get("etag") };
};
const poll = async (id: string) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await api.runs.getRun({ params: { runId: id } });
    assert.equal(response.status, 200, "immediately readable run");
    if (
      response.status === 200 &&
      ["completed", "failed"].includes(response.body.run.status)
    ) {
      console.log(
        `GET run ${id}: 200 version=${response.body.run.workflowVersion} status=${response.body.run.status} output=${JSON.stringify(response.body.run.output)} error=${response.body.run.error?.code ?? "-"}`,
      );
      return response.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${id} timed out`);
};
const begin = async (
  id: string,
  input: z.infer<typeof schemas.runInput>,
  version: number,
) => {
  const response = await startRun(api, {
    target: { kind: "workflow", id },
    input,
  });
  assert.equal(response.status, 202);
  if (response.status !== 202) throw new Error("Run rejected");
  assert.equal(response.body.run.workflowVersion, version);
  assert.equal(
    (await api.runs.getRun({ params: { runId: response.body.run.id } })).status,
    200,
  );
  console.log(
    `POST runs: 202 workflow=${id} run=${response.body.run.id} version=${version} input=${JSON.stringify(input)}`,
  );
  return response.body.run.id;
};
const create = async (body: Input) => {
  const result = await request("/workflows", "POST", 201, body);
  assert.equal(result.etag, '"v1"');
  assert.equal(result.body.version, 1);
  assert.ok(
    !(body.specification as { flows: { id?: string }[] }).flows.some(
      (node) => node.id === result.body.id,
    ),
  );
  const fetched = await request(`/workflows/${result.body.id}`, "GET", 200);
  assert.deepEqual(fetched.body.specification, body.specification);
  return result.body.id as string;
};

await request("/health", "GET", 200);
const invalid = {
  ...echo(),
  specification: {
    entry: "work",
    flows: (echo().specification as { flows: unknown[] }).flows,
  },
};
assert.equal(
  (await request("/workflows/validate", "POST", 200, invalid)).body.valid,
  false,
);
await request("/workflows", "POST", 400, invalid);
assert.equal(
  (await request("/workflows/validate", "POST", 200, multiply)).body.valid,
  true,
);
const id = await create(multiply);
const multiplication = await poll(await begin(id, { a: 13.75, b: -8 }, 1));
assert.equal(multiplication.run.status, "completed");
assert.equal(multiplication.run.output, -110);
assert.deepEqual(multiplication.conversations, []);
// Public finalization can precede the independent observation queue's drain.
const observationDeadline = Date.now() + 10_000;
const observed = new Set<string>();
while (Date.now() < observationDeadline) {
  const events = await api.runs.listEvents({
    params: { runId: multiplication.run.id },
    query: { after: 0, limit: 100 },
  });
  assert.equal(events.status, 200);
  if (events.status === 200)
    for (const event of events.body)
      if (typeof event.data?.nodeId === "string")
        observed.add(event.data.nodeId);
  if (["entry", "internal", "change", "switch"].every((id) => observed.has(id)))
    break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
for (const nodeId of ["entry", "internal", "change", "switch"])
  assert.ok(observed.has(nodeId), `Observed ${nodeId}`);
const updated = await request(`/workflows/${id}`, "PUT", 200, echo(), '"v1"');
assert.equal(updated.etag, '"v2"');
for (const input of [
  "native string",
  42,
  true,
  null,
  { nested: [false, 2] },
  [1, true, null, { nested: ["x", 2.5] }],
]) {
  const result = await poll(await begin(id, input, 2));
  assert.equal(result.run.status, "completed");
  assert.deepEqual(result.run.output, input);
}
const constructed = await create(
  echo("msg.payload={result:-110,nested:[true,null]};return msg;"),
);
assert.deepEqual((await poll(await begin(constructed, null, 1))).run.output, {
  result: -110,
  nested: [true, null],
});
await request(`/workflows/${constructed}`, "DELETE", 200);
await request(`/workflows/${id}`, "PUT", 412, echo(), '"v1"');
assert.equal((await request(`/workflows/${id}`, "GET", 200)).body.version, 2);

for (const [name, body] of [
  [
    "unreturnable",
    {
      engine: "node-red",
      specification: {
        entry: "entry",
        flows: [
          { id: "main", type: "tab" },
          { id: "entry", z: "main", type: "link in", wires: [[]] },
        ],
      },
    },
  ],
  [
    "missing runtime entry",
    {
      engine: "node-red",
      specification: {
        entry: "entry",
        flows: [
          { id: "main", type: "tab", disabled: true },
          { id: "entry", z: "main", type: "link in", wires: [[]] },
        ],
      },
    },
  ],
  [
    "unknown node",
    {
      engine: "node-red",
      specification: {
        entry: "entry",
        flows: [
          { id: "main", type: "tab" },
          { id: "entry", z: "main", type: "link in", wires: [["missing"]] },
          { id: "missing", z: "main", type: "aaas-not-installed" },
        ],
      },
    },
  ],
  ["node failure", echo("node.done(new Error('fixture failure'));return;")],
  ...[
    "Buffer.from('x')",
    "function(){}",
    "undefined",
    "NaN",
    "new Date()",
    "(()=>{const cycle={};cycle.self=cycle;return cycle;})()",
  ].map(
    (value) =>
      [`non-JSON ${value}`, echo(`msg.payload=${value};return msg;`)] as const,
  ),
] as const) {
  if (
    name === "unreturnable" &&
    process.env.NATIVE_BOUNDED_TIMEOUT !== "true"
  ) {
    console.log(
      "No-return timeout is exercised by native-acceptance.sh with its bounded test worker lifetime",
    );
    continue;
  }
  assert.equal(
    (await request("/workflows/validate", "POST", 200, body)).body.valid,
    true,
  );
  const broken = await create(body);
  const failed = await poll(await begin(broken, {}, 1));
  assert.equal(failed.run.status, "failed", name);
  if (name.startsWith("non-JSON") || name === "node failure")
    assert.equal(failed.run.error?.code, "workflow_failed", name);
  await request(`/workflows/${broken}`, "DELETE", 200);
}

await request(
  `/workflows/${id}`,
  "PUT",
  200,
  echo(
    "setTimeout(()=>{msg.payload='old';node.send(msg);node.done();},3000);return;",
  ),
  '"v2"',
);
const old = await begin(id, null, 3);
assert.equal(
  (
    await request(
      `/workflows/${id}`,
      "PUT",
      200,
      echo("msg.payload='new';return msg;"),
      '"v3"',
    )
  ).etag,
  '"v4"',
);
assert.equal((await poll(old)).run.output, "old");
assert.equal((await poll(await begin(id, false, 4))).run.output, "new");
await request(
  `/workflows/${id}`,
  "PUT",
  200,
  echo(
    "setTimeout(()=>{msg.payload='deleted snapshot';node.send(msg);node.done();},3000);return;",
  ),
  '"v4"',
);
const deleted = await begin(id, 1, 5);
await request(`/workflows/${id}`, "DELETE", 200);
assert.equal((await poll(deleted)).run.output, "deleted snapshot");
await request("/runs", "POST", 404, {
  target: { kind: "workflow", id },
  input: null,
});
assert.equal(
  (await request(`/runs/${old}`, "GET", 200)).body.run.workflowVersion,
  3,
);
console.log(
  "Native HTTP acceptance passed: multitab/subflow, JSON values, runtime failures, ETags and mutation snapshots",
);
await runControlAcceptance(base, token, multiplication.run.id);
