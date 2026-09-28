import { createClient, startRun, sendMessage } from "../../client/src/index.js";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error("DEMO_BASE_URL and API_TOKEN required");
const api = createClient(base, token);
function ensure(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
const reject = (
  result: { status: number; body: unknown },
  status: number,
  code: string,
) => {
  if (
    result.status !== status ||
    !result.body ||
    typeof result.body !== "object" ||
    !("error" in result.body) ||
    !result.body.error ||
    typeof result.body.error !== "object" ||
    !("code" in result.body.error) ||
    result.body.error.code !== code
  )
    throw new Error(
      `Expected ${status} ${code}, received ${result.status} ${JSON.stringify(result.body)}`,
    );
};
const poll = async (id: string) => {
  const deadline = Date.now() + 380_000;
  while (Date.now() < deadline) {
    const result = await api.runs.getRun({ params: { runId: id } });
    ensure(result.status === 200, "run disappeared");
    if (result.body.run.status === "completed") return result.body;
    if (result.body.run.status === "failed")
      throw new Error(`Run ${id} failed: ${result.body.run.error?.code}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Run ${id} exceeded polling deadline`);
};
const history = async (id: string) => {
  const result = await api.conversations.listMessages({
    params: { conversationId: id },
    query: { limit: 100 },
  });
  ensure(result.status === 200, "history unavailable");
  return result.body.items;
};
const target = { kind: "workflow" as const, workflowId: "node-red-demo" };
const workflow = (
  text: string,
  conversationIds?: { writer?: string; reviewer?: string },
  key?: string,
) =>
  startRun(
    api,
    {
      target,
      input: { text, ...(conversationIds ? { conversationIds } : {}) },
    },
    key,
  );

ensure((await fetch(`${base}/api/v1/health`)).ok, "health");
const openapi = await fetch(`${base}/api/v1/openapi.json`);
ensure(
  openapi.ok && JSON.stringify(await openapi.json()).includes("/api/v1/runs"),
  "OpenAPI",
);
const discovered = await api.workflows.listWorkflows({ query: { limit: 10 } });
ensure(
  discovered.status === 200 &&
    discovered.body.items.length === 1 &&
    discovered.body.items[0]?.id === target.workflowId,
  "workflow discovery",
);
const definition = await api.workflows.getWorkflow({
  params: { workflowId: target.workflowId },
});
ensure(
  definition.status === 200 && definition.body.readOnly,
  "workflow lookup",
);
for (const authorization of [undefined, "Bearer wrong"]) {
  const response = await fetch(`${base}/api/v1/runs`, {
    headers: authorization ? { authorization } : {},
  });
  reject(
    { status: response.status, body: await response.json() },
    401,
    "unauthorized",
  );
}
console.log("Health, OpenAPI, workflow and bearer checks passed");

const first = await workflow(
  "Draft a release note for a faster search index",
  undefined,
  "first-workflow-key",
);
ensure(
  first.status === 202 &&
    first.body.run.status === "queued" &&
    first.body.conversations?.length === 2,
  "workflow acceptance",
);
const links = first.body.conversations;
const writer = links.find(
  (link) => link.nodeId === "writer-node",
)?.conversationId;
const reviewer = links.find(
  (link) => link.nodeId === "reviewer-node",
)?.conversationId;
ensure(
  writer && reviewer && writer !== reviewer && !first.body.run.conversationId,
  "distinct links",
);
const immediate = await api.runs.getRun({
  params: { runId: first.body.run.id },
});
ensure(
  immediate.status === 200 &&
    immediate.body.run.id === first.body.run.id &&
    JSON.stringify(immediate.body.conversations) === JSON.stringify(links),
  "run and links immediately readable",
);
for (const [id, agentId] of [
  [writer, "writer"],
  [reviewer, "reviewer"],
]) {
  const conversation = await api.conversations.getConversation({
    params: { conversationId: id },
  });
  ensure(
    conversation.status === 200 && conversation.body.agentId === agentId,
    "immediate ownership",
  );
  await history(id);
}
const retry = await workflow(
  "Draft a release note for a faster search index",
  undefined,
  "first-workflow-key",
);
ensure(
  retry.status === 202 &&
    JSON.stringify(retry.body) === JSON.stringify(first.body),
  "immutable busy replay",
);
reject(
  await workflow("Different", undefined, "first-workflow-key"),
  409,
  "idempotency_conflict",
);
reject(await workflow("Conflict", { writer }), 409, "conversation_busy");
const complete = await poll(first.body.run.id);
const completedRetry = await workflow(
  "Draft a release note for a faster search index",
  undefined,
  "first-workflow-key",
);
ensure(
  completedRetry.status === 202 &&
    JSON.stringify(completedRetry.body) === JSON.stringify(first.body),
  "immutable completed replay",
);
ensure(
  complete.conversations?.length === 2 &&
    typeof complete.run.output === "string" &&
    complete.run.output.includes("Writer:") &&
    complete.run.output.includes("Reviewer:"),
  "workflow output",
);
const writerMessages = await history(writer);
const reviewerMessages = await history(reviewer);
ensure(
  writerMessages.length === 2 && reviewerMessages.length === 2,
  "both histories",
);
ensure(
  typeof writerMessages[1]?.content === "string" &&
    writerMessages[1].content.trim() &&
    typeof reviewerMessages[1]?.content === "string" &&
    reviewerMessages[1].content.trim(),
  "both agents produced nonempty replies",
);
ensure(
  writerMessages[0]?.role === "user" &&
    writerMessages[1]?.role === "assistant" &&
    reviewerMessages[0]?.role === "user" &&
    reviewerMessages[1]?.role === "assistant",
  "message order",
);
ensure(
  writerMessages.every((item) => item.runId === first.body.run.id) &&
    reviewerMessages.every((item) => item.runId === first.body.run.id),
  "run correlation",
);
ensure(
  typeof writerMessages[1]?.content === "string" &&
    String(reviewerMessages[0]?.content).includes(writerMessages[1].content),
  "reviewer prompt contains writer reply",
);
const events = await api.runs.listEvents({
  params: { runId: first.body.run.id },
  query: { after: 0, limit: 10 },
});
ensure(
  events.status === 200 &&
    events.body.map((item) => item.data?.status).join(",") ===
      "queued,running,completed" &&
    events.body.every((item, index) => item.sequence === index + 1),
  "ordered events",
);
const replayEvents = await api.runs.listEvents({
  params: { runId: first.body.run.id },
  query: { after: 1, limit: 1 },
});
ensure(
  replayEvents.status === 200 && replayEvents.body[0]?.sequence === 2,
  "event replay",
);
console.log(
  "Real writer → checkpoint → reviewer execution, histories and events passed",
);

for (const id of [writer, reviewer]) {
  const other = id === writer ? reviewer : writer;
  const before = (await history(other)).length;
  const sent = await sendMessage(
    api,
    id,
    "Remember the release note and give one short improvement.",
  );
  ensure(
    sent.status === 202 && sent.body.message.runId === sent.body.run.id,
    "direct chat accepted",
  );
  const done = await poll(sent.body.run.id);
  ensure(
    done.run.target?.kind === "agent" &&
      done.run.conversationId === id &&
      done.conversations?.[0]?.conversationId === id &&
      (await history(id)).length === 4 &&
      (await history(other)).length === before,
    "isolated direct chat",
  );
}
const direct = await startRun(api, {
  target: { kind: "agent", agentId: "writer" },
  input: { text: "Give one more short release note headline" },
  conversationId: writer,
});
ensure(
  direct.status === 202 &&
    direct.body.run.conversationId === writer &&
    direct.body.conversations?.[0]?.nodeId === "writer-node",
  "direct agent run accepted",
);
await poll(direct.body.run.id);
ensure(
  (await history(writer)).length === 6 &&
    (await history(reviewer)).length === 4,
  "agent run only grows writer",
);
const reused = await workflow("Update the release note for mobile users", {
  writer,
  reviewer,
});
ensure(
  reused.status === 202 &&
    reused.body.conversations?.map((link) => link.conversationId).join(",") ===
      links.map((link) => link.conversationId).join(","),
  "reuse links",
);
await poll(reused.body.run.id);
ensure(
  (await history(writer)).length === 8 &&
    (await history(reviewer)).length === 6,
  "resumed both agents",
);
const fresh = await workflow("Draft a short security release note");
ensure(
  fresh.status === 202 &&
    fresh.body.conversations?.every(
      (link) => ![writer, reviewer].includes(link.conversationId),
    ),
  "fresh pair",
);
await poll(fresh.body.run.id);
ensure(
  (await history(writer)).length === 8 &&
    (await history(reviewer)).length === 6,
  "fresh run does not change prior histories",
);
const mixed = await workflow("Draft a desktop release note", { writer });
ensure(
  mixed.status === 202 &&
    mixed.body.conversations?.find((link) => link.nodeId === "writer-node")
      ?.conversationId === writer &&
    mixed.body.conversations?.find((link) => link.nodeId === "reviewer-node")
      ?.conversationId !== reviewer,
  "mixed reuse",
);
await poll(mixed.body.run.id);
ensure(
  (await history(reviewer)).length === 6,
  "old reviewer history unchanged",
);
console.log(
  "Direct chat, confirmed session resumption, fresh and mixed reuse passed",
);

for (const ids of [
  { writer: reviewer },
  { reviewer: writer },
  { writer: "unknown" },
  { writer, reviewer: writer },
])
  reject(await workflow("Bad", ids), 400, "invalid_input");
for (const body of [
  { target, input: { text: "Bad", extra: true } },
  { target, input: { text: " " } },
  { target, input: { text: "Bad" }, engineOptions: { cwd: "/tmp" } },
  { target: { kind: "agent", agentId: "other" }, input: { text: "Bad" } },
])
  reject(
    await startRun(api, body as Parameters<typeof startRun>[1]),
    400,
    "invalid_input",
  );
reject(
  await api.conversations.createConversation({ body: {} }),
  400,
  "invalid_input",
);
reject(
  await api.conversations.createConversation({ body: { agentId: "other" } }),
  400,
  "invalid_input",
);
reject(
  await api.conversations.sendMessage({
    params: { conversationId: writer },
    body: { content: [{ type: "text", text: "structured" }] },
  }),
  400,
  "unsupported_content",
);
reject(
  await api.runs.cancelRun({ params: { runId: first.body.run.id }, body: {} }),
  501,
  "not_implemented",
);
const stream = await fetch(
  `${base}/api/v1/runs/${first.body.run.id}/events/stream`,
  { headers: { authorization: `Bearer ${token}` } },
);
reject(
  { status: stream.status, body: await stream.json() },
  501,
  "not_implemented",
);
console.log(
  "Negative validation and typed 501 checks passed; Node-RED agents demo complete",
);
