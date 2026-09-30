import { createClient, startRun } from "../../client/src/index.js";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error("DEMO_BASE_URL and API_TOKEN required");
const api = createClient(base, token);
const auth = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
const managed = (label: string) => ({
  engine: "node-red",
  specificationVersion: "managed-v1",
  specification: {
    label,
    entry: "writer",
    finalizer: "writer",
    configs: [],
    nodes: [{ id: "writer", type: "agent", name: "Writer", wires: [[], []] }],
  },
});
const call = (
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = auth,
) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const observed = async (
  detail: {
    run: { id: string };
    executions?: {
      id: string;
      runId: string;
      key?: string | null;
      status: string;
    }[];
  },
  nodeId: string,
  minimum: number,
) => {
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    (detail.executions ?? []).filter(
      (execution) =>
        execution.key?.endsWith(nodeId) && execution.status === "completed",
    ).length < minimum
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const updated = await api.runs.getRun({ params: { runId: detail.run.id } });
    ensure(updated.status === 200, `Run ${detail.run.id} disappeared`);
    detail = updated.body;
  }
  const executions = detail.executions ?? [];
  ensure(executions.length > 0, `No node executions for ${detail.run.id}`);
  ensure(
    new Set(executions.map((execution) => execution.id)).size ===
      executions.length &&
      executions.every((execution) => execution.runId === detail.run.id),
    `Invalid invocation IDs for ${detail.run.id}`,
  );
  ensure(
    executions.filter(
      (execution) =>
        execution.key?.endsWith(nodeId) && execution.status === "completed",
    ).length >= minimum,
    `Missing completed ${nodeId} invocations for ${detail.run.id}: ${JSON.stringify(executions)}`,
  );
};
const poll = async (id: string) => {
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const result = await api.runs.getRun({ params: { runId: id } });
    ensure(result.status === 200, "run disappeared");
    if (result.body.run.status === "completed") return result.body;
    if (result.body.run.status === "failed")
      throw new Error(`Run ${id} failed: ${result.body.run.error?.code}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Run exceeded polling deadline");
};

ensure((await fetch(`${base}/api/v1/health`)).ok, "health");
const openapi = await fetch(`${base}/api/v1/openapi.json`);
ensure(
  openapi.ok && JSON.stringify(await openapi.json()).includes("/api/v1/runs"),
  "OpenAPI",
);
const first = await startRun(api, {
  target: { kind: "workflow", workflowId: "node-red-demo" },
  input: { text: "A faster search index" },
});
const second = await startRun(api, {
  target: { kind: "workflow", workflowId: "node-red-demo" },
  input: { text: "Clearer navigation" },
});
ensure(
  first.status === 202 &&
    second.status === 202 &&
    first.body.conversations?.length === 0,
  "prompt run acceptance",
);
for (const accepted of [first, second]) {
  const id = accepted.body.run.id;
  const complete = await poll(id);
  ensure(
    complete.conversations?.length === 3 && complete.run.output,
    "parallel branches joined and final agent completed",
  );
  for (const link of complete.conversations) {
    const conversation = await api.conversations.getConversation({
      params: { conversationId: link.conversationId },
    });
    const messages = await api.conversations.listMessages({
      params: { conversationId: link.conversationId },
      query: { limit: 10 },
    });
    ensure(
      conversation.status === 200 &&
        conversation.body.agentId === link.nodeId &&
        messages.status === 200 &&
        messages.body.items.length === 2 &&
        messages.body.items.every((message) => message.runId === id),
      "readable correlated conversation",
    );
  }
  ensure(
    complete.conversations.filter((link) => link.nodeId === "writer-agent")
      .length === 2,
    "repeated writer invocation",
  );
  await observed(complete, "writer-agent", 2);
  await observed(complete, "reviewer-agent", 1);
  for (const nodeId of [
    "aaas-probe-exec",
    "aaas-probe-file",
    "aaas-probe-list",
    "aaas-probe-check",
  ])
    await observed(complete, nodeId, 1);
  console.log(
    `Observed run ${id}: 3 linked conversations with complete messages`,
  );
}
const listed = await api.runs.listRuns({ query: { limit: 1 } });
ensure(
  listed.status === 200 && listed.body.nextCursor,
  "paginated run inventory",
);
console.log("Real Node-RED agent lifecycle walkthrough complete");
const core = await api.workflows.getWorkflow({
  params: { workflowId: "node-red-demo" },
});
ensure(
  core.status === 200 && core.body.name === "Core" && core.body.readOnly,
  "Core visibility",
);
ensure(
  (await call("/workflows/node-red-demo", "DELETE")).status === 403,
  "Core immutable",
);
ensure(
  (await call("/workflows/node-red-demo", "PUT", managed("No"))).status === 403,
  "Core update immutable",
);
const valid = await call(
  "/workflows/validate",
  "POST",
  managed("Managed writer"),
);
ensure(
  valid.status === 200 && (await valid.json()).valid,
  "managed validation",
);
for (const specification of [
  {
    ...managed("Bad").specification,
    nodes: [
      { id: "writer", type: "agent", name: "Writer", wires: [["missing"], []] },
    ],
  },
  {
    ...managed("Bad").specification,
    nodes: [
      managed("Bad").specification.nodes[0],
      managed("Bad").specification.nodes[0],
    ],
  },
  {
    ...managed("Bad").specification,
    nodes: [{ id: "writer", type: "function", name: "X", wires: [[], []] }],
  },
  {
    ...managed("Bad").specification,
    nodes: [
      { ...managed("Bad").specification.nodes[0], credentials: { key: "bad" } },
    ],
  },
  { ...managed("Bad").specification, endpoint: "/private" },
]) {
  const invalid = await call("/workflows/validate", "POST", {
    ...managed("Bad"),
    specification,
  });
  ensure(
    invalid.status === 200 && !(await invalid.json()).valid,
    "invalid specification rejected",
  );
}
const created = await call("/workflows", "POST", managed("Managed writer"));
ensure(
  created.status === 201 && created.headers.get("etag") === '"v1"',
  "managed creation and ETag",
);
const definition = (await created.json()) as { id: string };
const id = definition.id;
console.log(`Created managed tab ${id}: 201 "v1"`);
ensure(
  (await call(`/workflows/${id}`, "GET")).headers.get("etag") === '"v1"',
  "managed get ETag",
);
const managedRun = await startRun(api, {
  target: { kind: "workflow", workflowId: id },
  input: { text: "A small release note" },
});
ensure(
  managedRun.status === 202 && managedRun.body.run.workflowVersion === 1,
  "managed run acceptance",
);
const managedResult = await poll(managedRun.body.run.id);
ensure(managedResult.conversations?.length === 1, "managed agent conversation");
await observed(managedResult, "-writer", 1);
const managedMessages = await api.conversations.listMessages({
  params: { conversationId: managedResult.conversations[0].conversationId },
  query: { limit: 10 },
});
ensure(
  managedMessages.status === 200 &&
    managedMessages.body.items.some(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.trim(),
    ),
  "real managed agent reply",
);
const stale = await call(`/workflows/${id}`, "PUT", managed("Stale"), {
  ...auth,
  "if-match": '"v9"',
});
ensure(stale.status === 412, "stale precondition");
const updated = await call(
  `/workflows/${id}`,
  "PUT",
  managed("Updated writer"),
  { ...auth, "if-match": '"v1"' },
);
ensure(
  updated.status === 200 && updated.headers.get("etag") === '"v2"',
  "managed update",
);
console.log(`Updated managed tab ${id}: 200 "v2"`);
const secondRun = await startRun(api, {
  target: { kind: "workflow", workflowId: id },
  input: { text: "A new release note" },
});
ensure(
  secondRun.status === 202 && secondRun.body.run.workflowVersion === 2,
  "updated version runs",
);
await observed(await poll(secondRun.body.run.id), "-writer", 1);
ensure(
  (
    await call(`/workflows/${id}`, "PUT", managed("Still stale"), {
      ...auth,
      "if-match": '"v1"',
    })
  ).status === 412,
  "unchanged stale version",
);
const unconditional = await call(
  `/workflows/${id}`,
  "PUT",
  managed("Final writer"),
);
ensure(
  unconditional.status === 200 && unconditional.headers.get("etag") === '"v3"',
  "unconditional update",
);
ensure(
  (await call(`/workflows/${id}`, "DELETE")).status === 200,
  "managed deletion",
);
ensure(
  (await call(`/workflows/${id}`, "GET")).status === 404,
  "managed absence",
);
ensure(
  (await call(`/runs/${managedRun.body.run.id}`, "GET")).status === 200,
  "historical run retention",
);
ensure(
  (
    await call("/runs", "POST", {
      target: { kind: "workflow", workflowId: id },
      input: { text: "Rejected" },
    })
  ).status === 404,
  "deleted workflow not runnable",
);
console.log(
  `Deleted managed tab ${id}: 200; past runs ${managedRun.body.run.id}, ${secondRun.body.run.id} retained`,
);
