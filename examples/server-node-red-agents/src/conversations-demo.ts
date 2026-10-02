import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";
import { z as validator } from "zod";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
const compose = process.env.DEMO_COMPOSE_PROJECT;
if (!base || !token || !compose)
  throw new Error("DEMO_BASE_URL, API_TOKEN and DEMO_COMPOSE_PROJECT required");
if (process.env.DEFAULT_MODEL !== "github-copilot/gpt-6-luna")
  throw new Error("Use DEFAULT_MODEL=github-copilot/gpt-6-luna");
const call = async (
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  key?: string,
): Promise<unknown> => {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result: unknown = await response.json();
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${JSON.stringify(result)}`,
  );
  return result;
};
const inspect = (script: string, args: string[] = []) =>
  execFileSync(
    "docker",
    [
      "compose",
      "-p",
      compose,
      "-f",
      "examples/server-node-red-agents/compose.yaml",
      "exec",
      "-T",
      "node-red",
      "node",
      "-e",
      script,
      ...args,
    ],
    { encoding: "utf8", timeout: 20_000 },
  ).trim();
const create = async (body: unknown = {}) =>
  schemas.conversation.parse(await call("/conversations", "POST", body, 201));
const send = async (id: string, content: string, key?: string) =>
  schemas.sentMessage.parse(
    await call(`/conversations/${id}/messages`, "POST", { content }, 202, key),
  );
const messages = async (id: string) =>
  zpage.parse(await call(`/conversations/${id}/messages?limit=100`)).items;
// Parse live responses against the production contract rather than duplicating resource shapes.
const zpage = validator.object({ items: validator.array(schemas.message) });
const get = async (id: string) =>
  schemas.runDetail.parse(await call(`/runs/${id}`));
const poll = async (id: string, status = "completed") => {
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    const detail = await get(id);
    if (["completed", "failed", "cancelled"].includes(detail.run.status)) {
      assert.equal(detail.run.status, status, JSON.stringify(detail.run.error));
      console.log(`Conversation acceptance run=${id} status=${status}`);
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run ${id} exceeded deadline`);
};
const success = async (
  accepted: z.infer<typeof schemas.sentMessage>,
  count: number,
  resumed = false,
) => {
  assert.equal(accepted.run.target, undefined);
  assert.equal(
    (await get(accepted.run.id)).run.conversationId,
    accepted.message.conversationId,
  );
  const detail = await poll(accepted.run.id);
  const history = await messages(accepted.message.conversationId);
  assert.equal(history.length, count);
  assert.deepEqual(history.at(-2), accepted.message);
  assert.equal(history.at(-1)!.role, "assistant");
  if (resumed) {
    const events = validator
      .array(schemas.event)
      .parse(await call(`/runs/${accepted.run.id}/events?after=0&limit=100`));
    assert.ok(
      events.some(
        (event) =>
          event.type === "execution.terminal" && event.data?.resumed === true,
      ),
      "Provider must confirm resume",
    );
    console.log(`Confirmed resume run=${accepted.run.id}`);
  }
  return detail;
};

const project = schemas.project.parse(
  await call("/projects", "POST", { name: "Conversation acceptance" }, 201),
);
const workerDirectories = () =>
  inspect(
    "process.stdout.write(JSON.stringify(require('fs').readdirSync(require('os').tmpdir()).filter(name=>name.startsWith('aaas-worker-')).sort()))",
  );
const cleanupDeadline = Date.now() + 30_000;
while (workerDirectories() !== "[]" && Date.now() < cleanupDeadline)
  await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(
  workerDirectories(),
  "[]",
  "Prior demo workers must finish cleanup",
);
const beforeCreate = workerDirectories();
const unused = await create({ projectId: project.id });
await call(`/conversations/${unused.id}`, "DELETE");
await call(`/conversations/${unused.id}`, "GET", undefined, 404);
const conversation = await create({ projectId: project.id });
assert.equal(
  workerDirectories(),
  beforeCreate,
  "Metadata create must not start a worker",
);
await call(
  `/conversations/${conversation.id}/messages`,
  "POST",
  { content: [{ type: "text", text: "Unsupported structured content" }] },
  400,
);
assert.deepEqual(await messages(conversation.id), []);
await call(`/conversations/${conversation.id}`, "PATCH", { title: "Renamed" });
const listed = validator
  .object({ items: validator.array(schemas.conversation) })
  .parse(
    await call(
      `/conversations?projectId=${project.id}&targetKind=workflow&targetId=core`,
    ),
  );
assert.ok(
  listed.items.some(
    (item) => item.id === conversation.id && item.title === "Renamed",
  ),
);
const key = randomUUID();
const prompt = "Run pwd and include its exact output. Reply briefly.";
const first = await send(conversation.id, prompt, key);
assert.deepEqual(await send(conversation.id, prompt, key), first);
await call(
  `/conversations/${conversation.id}/messages`,
  "POST",
  { content: "Conflict" },
  409,
  key,
);
const firstDetail = await success(first, 2);
assert.ok(String(firstDetail.run.output).includes(project.localPath!));
await call(`/projects/${project.id}`, "PATCH", { name: "Renamed project" });
const second = await send(conversation.id, prompt);
assert.ok(
  String((await success(second, 4, true)).run.output).includes(
    project.localPath!,
  ),
);
assert.deepEqual((await get(first.run.id)).run, firstDetail.run);

// Same raw key on another endpoint is independent; immediate cancellation is deterministic.
const independent = schemas.runDetail.parse(
  await call(
    "/runs",
    "POST",
    {
      target: { kind: "workflow", id: "core" },
      input: { text: "Reply briefly" },
    },
    202,
    key,
  ),
);
await call(`/runs/${independent.run.id}/cancel`, "POST", {});
const empty = await create();
// Whitespace is contract-valid plain text but not an executable agent prompt.
const failingFirst = await send(empty.id, " ");
await poll(failingFirst.run.id, "failed");
assert.deepEqual(await messages(empty.id), []);
const cancelled = await send(empty.id, "Run sleep 30 before replying", key);
await call(`/runs/${cancelled.run.id}/cancel`, "POST", {});
await poll(cancelled.run.id, "cancelled");
assert.deepEqual(await messages(empty.id), []);
assert.deepEqual(
  await send(empty.id, "Run sleep 30 before replying", key),
  cancelled,
);
await call(`/conversations/${empty.id}`, "DELETE");
assert.deepEqual(
  await send(empty.id, "Run sleep 30 before replying", key),
  cancelled,
);

// Only this script's project file is inspected. Native upstream writes are never replayed.
const sentinel = `${project.localPath}/conversation-sentinel-${randomUUID()}`;
const core = schemas.definition.parse(await call("/workflows/core"));
const specification = core.specification as {
  entry: string;
  flows: Record<string, unknown>[];
};
const source = specification.flows.find((node) => node.id === "orchestrator")!;
const definition = (agent: Record<string, unknown> = {}) => ({
  engine: "node-red",
  name: "Conversation source",
  specification: {
    entry: "entry",
    flows: [
      { id: "tab", type: "tab", label: "Conversation source" },
      {
        id: "entry",
        type: "link in",
        z: "tab",
        x: 100,
        y: 100,
        wires: [["sentinel"]],
      },
      {
        id: "sentinel",
        type: "function",
        z: "tab",
        x: 200,
        y: 100,
        outputs: 1,
        func: "msg.payload='once';return msg;",
        wires: [["file"]],
      },
      {
        id: "file",
        type: "file",
        z: "tab",
        x: 300,
        y: 100,
        filename: sentinel,
        filenameType: "str",
        appendNewline: true,
        createDir: false,
        overwriteFile: "false",
        encoding: "utf8",
        wires: [["custom-agent"]],
      },
      {
        ...source,
        id: "custom-agent",
        z: "tab",
        x: 400,
        y: 100,
        ...agent,
        wires: [["delay"], []],
      },
      {
        id: "delay",
        type: "delay",
        z: "tab",
        x: 500,
        y: 100,
        pauseType: "delay",
        timeout: "20",
        timeoutUnits: "seconds",
        wires: [["return"]],
      },
      {
        id: "return",
        type: "link out",
        z: "tab",
        x: 600,
        y: 100,
        mode: "return",
        links: [],
      },
    ],
  },
});
const workflow = schemas.definition.parse(
  await call("/workflows", "POST", definition(), 201),
);
const original = schemas.runDetail.parse(
  await call(
    "/runs",
    "POST",
    {
      projectId: project.id,
      target: { kind: "workflow", id: workflow.id },
      input: { text: "Reply with one short sentence." },
    },
    202,
  ),
);
const deadline = Date.now() + 480_000;
let observed: string | undefined;
let busyVerified = false;
while (Date.now() < deadline) {
  const detail = await get(original.run.id);
  observed = detail.conversations?.[0]?.conversationId;
  if (observed && (await messages(observed)).length === 2) {
    assert.equal(detail.run.status, "running");
    await call(
      `/conversations/${observed}/messages`,
      "POST",
      { content: "Busy" },
      409,
    );
    await call(`/conversations/${observed}`, "DELETE", undefined, 409);
    busyVerified = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(observed, "Workflow must establish a conversation");
assert.ok(
  busyVerified,
  "Whole originating workflow busy guard must be exercised",
);
await poll(original.run.id);
// Node hooks drain independently of public completion. Wait for the known native deliveries.
const drainDeadline = Date.now() + 20_000;
while (Date.now() < drainDeadline) {
  const detail = await get(original.run.id);
  if (
    ["custom-agent", "delay", "return"].every((key) =>
      detail.executions?.some(
        (execution) =>
          execution.key === key && execution.status === "completed",
      ),
    )
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const historical = await get(original.run.id);
assert.ok(
  ["custom-agent", "delay", "return"].every((key) =>
    historical.executions?.some(
      (execution) => execution.key === key && execution.status === "completed",
    ),
  ),
  "Expected native observations must drain",
);
const historicalEvents = await call(
  `/runs/${original.run.id}/events?after=0&limit=100`,
);
assert.equal(
  schemas.conversation.parse(await call(`/conversations/${observed}`))
    .projectId,
  project.id,
);
const readSentinel = () =>
  inspect(
    "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
    [sentinel],
  );
assert.equal(readSentinel(), "once");
const drift = {
  outputFormat: JSON.stringify({
    type: "object",
    properties: { currentConfig: { const: "issue51-current" } },
    required: ["currentConfig"],
    additionalProperties: false,
  }),
};
await call(`/workflows/${workflow.id}`, "PUT", definition(drift));
const continued = await send(observed, "Reply briefly.");
const current = await success(continued, 4, true);
assert.deepEqual(JSON.parse(String(current.run.output)), {
  currentConfig: "issue51-current",
});
assert.equal(readSentinel(), "once");
assert.deepEqual(await get(original.run.id), historical);
assert.deepEqual(
  await call(`/runs/${original.run.id}/events?after=0&limit=100`),
  historicalEvents,
);

// Valid identity, incompatible current runtime configuration: accepted then failed, no history pair.
await call(
  `/workflows/${workflow.id}`,
  "PUT",
  definition({ outputFormat: "invalid-json" }),
);
const failureKey = randomUUID();
const failed = await send(
  observed,
  "Must fail current configuration",
  failureKey,
);
await poll(failed.run.id, "failed");
assert.equal((await messages(observed)).length, 4);
assert.deepEqual(
  await send(observed, "Must fail current configuration", failureKey),
  failed,
);
await call(`/workflows/${workflow.id}`, "PUT", definition());
// Cancellation of an established session while the real CLI is executing.
const slow = await send(
  observed,
  "Use bash to run sleep 30, then reply briefly.",
);
const startedDeadline = Date.now() + 60_000;
let started = false;
while (Date.now() < startedDeadline) {
  const events = validator
    .array(schemas.event)
    .parse(await call(`/runs/${slow.run.id}/events?after=0&limit=100`));
  if (events.some((event) => event.type === "execution.started")) {
    started = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(started, "Slow continuation must start before cancellation");
await call(`/runs/${slow.run.id}/cancel`, "POST", {});
await poll(slow.run.id, "cancelled");
assert.equal((await messages(observed)).length, 4);
await success(await send(observed, "Reply briefly without tools."), 6, true);
assert.equal(readSentinel(), "once");
await call(
  `/workflows/${workflow.id}`,
  "PUT",
  definition({ type: "function" }),
);
await call(
  `/conversations/${observed}/messages`,
  "POST",
  { content: "Missing agent" },
  409,
);
await call(
  `/workflows/${workflow.id}`,
  "PUT",
  definition({ id: "replacement-agent" }),
);
await call(
  `/conversations/${observed}/messages`,
  "POST",
  { content: "Renamed source node" },
  409,
);
await call(`/workflows/${workflow.id}`, "DELETE");
await call(
  `/conversations/${observed}/messages`,
  "POST",
  { content: "Missing workflow" },
  409,
);

// Unavailable cwd must fail before acceptance, then restore the owned directory in place.
inspect(
  "require('fs').renameSync(process.argv[1],process.argv[1]+'.unavailable')",
  [project.localPath!],
);
try {
  await call(
    `/conversations/${conversation.id}/messages`,
    "POST",
    { content: "Unavailable cwd" },
    503,
  );
} finally {
  inspect(
    "require('fs').renameSync(process.argv[1]+'.unavailable',process.argv[1])",
    [project.localPath!],
  );
}
await call(`/conversations/${observed}`, "DELETE");
assert.deepEqual(
  await send(observed, "Must fail current configuration", failureKey),
  failed,
);
console.log(
  `Conversation acceptance passed: core=${conversation.id} source=${observed} workflow=${workflow.id} cwd=${project.localPath} sentinel=once config=issue51-current`,
);
