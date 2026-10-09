import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const base = process.env.DEMO_BASE_URL!;
const project = process.env.COMPOSE_PROJECT_NAME!;
const token = process.env.API_TOKEN!;
const compose = [
  "compose",
  "-p",
  project,
  ...(
    process.env.NODE_RED_COMPOSE_FILES ??
    "examples/server-node-red-agents/compose.yaml,examples/server-node-red-agents/node-red/fixtures/compose.native.yaml"
  )
    .split(",")
    .flatMap((file) => ["-f", file]),
];
const sleep = () => new Promise((resolve) => setTimeout(resolve, 100));
async function http(
  method: string,
  path: string,
  body?: unknown,
  expected = 200,
  key?: string,
) {
  console.log(
    `curl -sS -X ${method} '${base}${path}' -H 'Authorization: Bearer $API_TOKEN'${body === undefined ? "" : ` -H 'Content-Type: application/json' --data '${JSON.stringify(body)}'`}${key ? ` -H 'Idempotency-Key: ${key}'` : ""}`,
  );
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const value = await response.json();
  console.log(JSON.stringify({ httpStatus: response.status, body: value }));
  assert.equal(response.status, expected);
  return value;
}
async function capacity() {
  const result = execFileSync(
    "docker",
    [
      ...compose,
      "exec",
      "-T",
      "node-red",
      "node",
      "-e",
      "fetch('http://127.0.0.1:1881/capacity',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(async r=>{if(!r.ok)throw Error('capacity');process.stdout.write(await r.text())}).catch(()=>process.exit(1))",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  return JSON.parse(result);
}
async function zero() {
  const deadline = Date.now() + 20000;
  while (true) {
    const state = await capacity();
    if (state.occupied === 0 && state.waiting.length === 0) {
      console.log(
        JSON.stringify({
          evidence: "zero worker capacity during human wait",
          ...state,
        }),
      );
      return;
    }
    assert.ok(Date.now() < deadline, "Workers were not released");
    await sleep();
  }
}
async function status(id: string, expected: string) {
  const deadline = Date.now() + 35000;
  while (true) {
    const response = await fetch(`${base}/api/v1/runs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const detail = await response.json();
    if (detail.run.status === expected) {
      console.log(JSON.stringify({ evidence: "run status", ...detail }));
      return detail;
    }
    assert.ok(
      !["failed", "cancelled"].includes(detail.run.status),
      JSON.stringify(detail),
    );
    assert.ok(Date.now() < deadline, `Run ${id} did not reach ${expected}`);
    await sleep();
  }
}

const definition = {
  name: "Interaction acceptance",
  engine: "node-red",
  specification: {
    entry: "entry",
    flows: [
      { id: "tab", type: "tab", label: "Interaction acceptance" },
      { id: "entry", z: "tab", type: "link in", wires: [["before"]] },
      {
        id: "before",
        z: "tab",
        type: "change",
        rules: [
          {
            t: "set",
            p: "before",
            pt: "msg",
            to: "($exists(before) ? before : 0) + 1",
            tot: "jsonata",
          },
        ],
        wires: [["human"]],
      },
      {
        id: "human",
        z: "tab",
        type: "interaction",
        name: "Human",
        prompt: "Continue?",
        promptType: "str",
        decisions: [
          { id: "approve", label: "Approve" },
          { id: "revise", label: "Revise" },
        ],
        wires: [["after"], []],
      },
      {
        id: "after",
        z: "tab",
        type: "change",
        rules: [
          {
            t: "set",
            p: "after",
            pt: "msg",
            to: "($exists(after) ? after : 0) + 1",
            tot: "jsonata",
          },
          {
            t: "set",
            p: "payload",
            pt: "msg",
            to: '{"before":before,"after":after,"interaction":interaction,"original":input}',
            tot: "jsonata",
          },
        ],
        wires: [["native-return"]],
      },
      {
        id: "native-return",
        z: "tab",
        type: "link out",
        mode: "return",
        wires: [],
      },
    ],
  },
};
const workflow = await http("POST", "/api/v1/workflows", definition, 201);
const owner = await http(
  "POST",
  "/api/v1/projects",
  { name: "Interaction project" },
  201,
);
async function pause() {
  const accepted = await http(
    "POST",
    "/api/v1/runs",
    {
      target: { kind: "workflow", id: workflow.id },
      projectId: owner.id,
      input: { original: "preserved" },
    },
    202,
  );
  const id = accepted.run.id;
  const detail = await status(id, "paused");
  await zero();
  const events = await http("GET", `/api/v1/runs/${id}/events?limit=100`);
  assert.ok(
    events.some(
      (event: { type: string; data: { status?: string } }) =>
        event.type === "run.updated" && event.data.status === "running",
    ),
  );
  assert.equal(
    events.filter(
      (event: { type: string; data: { nodeId?: string } }) =>
        event.type === "node.received" && event.data.nodeId === "before",
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event: { type: string; data: { nodeId?: string } }) =>
        event.type === "node.received" && event.data.nodeId === "after",
    ).length,
    0,
  );
  const page = await http(
    "GET",
    `/api/v1/interactions?projectId=${owner.id}&limit=100`,
  );
  const interaction = page.items.find(
    (item: { runId: string }) => item.runId === id,
  );
  assert.deepEqual(interaction, {
    id: detail.interactions[0].id,
    runId: id,
    prompt: "Continue?",
    decisions: ["approve", "revise"],
    status: "pending",
  });
  assert.equal(
    (await http("GET", "/api/v1/interactions?projectId=unrelated")).items
      .length,
    0,
  );
  return { id, interaction };
}
const first = await pause();
// MAX_WORKERS=1: another admission proves that the paused run holds no slot.
const cancelled = await pause();
const edited = structuredClone(definition);
edited.specification.flows.find((node) => node.id === "after")!.rules![0].to =
  "999";
await http("PUT", `/api/v1/workflows/${workflow.id}`, edited);
await http("POST", `/api/v1/runs/${first.id}/resume`, {}, 409);
await http(
  "POST",
  `/api/v1/interactions/${first.interaction.id}/decisions`,
  { decision: "undeclared" },
  400,
);
await status(first.id, "paused");
await zero();
const body = { decision: "revise", comment: "add one more test" };
const path = `/api/v1/interactions/${first.interaction.id}/decisions`;
const accepted = await http("POST", path, body, 200, "interaction-acceptance");
assert.equal(accepted.run.id, first.id);
assert.equal(accepted.run.status, "running");
const final = await status(first.id, "completed");
assert.deepEqual(final.run.output, {
  before: 1,
  after: 1,
  interaction: {
    id: first.interaction.id,
    decision: "revise",
    text: "add one more test",
  },
  original: { original: "preserved" },
});
assert.deepEqual(
  await http("POST", path, body, 200, "interaction-acceptance"),
  accepted,
);
await http(
  "POST",
  path,
  { decision: "approve" },
  409,
  "interaction-acceptance",
);
await http("POST", path, body, 409);
await zero();
const events = await http("GET", `/api/v1/runs/${first.id}/events?limit=100`);
for (const nodeId of ["before", "after"])
  assert.equal(
    events.filter(
      (event: { type: string; data: { nodeId?: string } }) =>
        event.type === "node.received" && event.data.nodeId === nodeId,
    ).length,
    1,
  );
assert.deepEqual(
  events
    .filter((event: { type: string }) => event.type === "run.updated")
    .map((event: { data: { status: string } }) => event.data.status),
  ["queued", "running", "paused", "running", "completed"],
);
await http("POST", `/api/v1/runs/${cancelled.id}/cancel`, {});
await http(
  "POST",
  `/api/v1/interactions/${cancelled.interaction.id}/decisions`,
  body,
  409,
);
assert.equal((await http("GET", "/api/v1/interactions")).items.length, 0);
assert.equal((await http("GET", "/api/v1/runs?limit=100")).items.length, 2);
await zero();
console.log(
  "Interaction native public HTTP acceptance passed: same run, snapshot protected, before=1 after=1, ordered choices, text mapping, worker-free wait, capacity=1, duplicate/idempotency/invalid/cancellation guards.",
);
