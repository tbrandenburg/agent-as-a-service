import { createClient, sendMessage } from "../../client/src/index.js";

const color = (code: number, value: string) =>
  process.stdout.isTTY ? `\u001b[${code}m${value}\u001b[0m` : value;
const title = (number: number, label: string) =>
  console.log(
    `\n${color(36, `━━ ${String(number).padStart(2, "0")}  ${label} ━━`)}`,
  );
const line = (label: string, value: string) =>
  console.log(`  ${color(32, "✓")} ${label}: ${value}`);
const requireStatus = (actual: number, wanted: number, operation: string) => {
  if (actual !== wanted)
    throw new Error(`${operation}: expected HTTP ${wanted}, got ${actual}`);
};

const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS ?? 300_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
  throw new Error("OPENCODE_TIMEOUT_MS must be a positive integer");
const token = process.env.API_TOKEN;
if (!token?.trim()) throw new Error("API_TOKEN must be supplied");
const base = process.env.DEMO_BASE_URL;
if (!base || !/^https?:\/\//.test(base))
  throw new Error("DEMO_BASE_URL must be supplied as an HTTP(S) URL");
const api = createClient(base, token);

const wait = async (runId: string) => {
  const deadline = Date.now() + timeoutMs + 15_000;
  while (Date.now() < deadline) {
    const result = await api.runs.getRun({ params: { runId } });
    requireStatus(result.status, 200, "getRun");
    if (result.status !== 200) throw new Error("Missing run");
    if (["completed", "failed"].includes(result.body.run.status))
      return result.body.run;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Run ${runId} exceeded demo polling deadline`);
};

console.log(color(1, "Agent as a Service  ·  real OpenCode HTTP demo"));
console.log(`Using the published Docker contract server on ${base}`);

title(1, "Discover the API and authenticate");
const health = await fetch(`${base}/api/v1/health`);
requireStatus(health.status, 200, "getHealth");
line("Public health", "HTTP 200");
const openapi = await fetch(`${base}/api/v1/openapi.json`);
requireStatus(openapi.status, 200, "getOpenApiDocument");
const openapiDocument = (await openapi.json()) as { paths?: unknown };
if (!openapiDocument.paths || Object.keys(openapiDocument.paths).length < 22)
  throw new Error("OpenAPI document did not expose the contract paths");
line("Public OpenAPI", "HTTP 200 · contract paths available");
const status = await api.system.getStatus();
requireStatus(status.status, 200, "authenticated getStatus");
if (status.status !== 200) throw new Error("Missing status response");
line("Authenticated status", "HTTP 200 · bearer token accepted");

title(2, "Open a conversation with the real agent");
const conversation = await api.conversations.createConversation({
  body: { title: "Checkout reliability review" },
});
requireStatus(conversation.status, 201, "createConversation");
if (conversation.status !== 201) throw new Error("Missing conversation");
line(
  "Conversation",
  `${conversation.body.id} · agent ${conversation.body.agentId} · HTTP 201`,
);

title(3, "Ask for concrete advice and read the accepted run");
const marker = Math.random().toString(36).slice(2, 9);
const prompt = `A checkout API receives duplicate payment callbacks. Give three concrete engineering safeguards against double charging, in three short numbered sentences. For later context, the release tag is ${marker}; do not mention the tag in this answer.`;
const first = await sendMessage(
  api,
  conversation.body.id,
  prompt,
  "opencode-demo-first",
);
requireStatus(first.status, 202, "first sendMessage");
if (first.status !== 202) throw new Error("Missing accepted message");
line("Accepted message", `${first.body.message.id} · HTTP 202`);
const immediate = await api.runs.getRun({
  params: { runId: first.body.run.id },
});
requireStatus(immediate.status, 200, "getRun immediately after 202");
line("Immediately readable run", `${first.body.run.id} · HTTP 200`);

title(4, "Retry safely and read the real assistant reply");
const replay = await sendMessage(
  api,
  conversation.body.id,
  prompt,
  "opencode-demo-first",
);
requireStatus(replay.status, 202, "idempotent message retry");
if (
  replay.status !== 202 ||
  replay.body.run.id !== first.body.run.id ||
  replay.body.message.id !== first.body.message.id
)
  throw new Error("Idempotent retry did not replay the original acceptance");
line("Same key + same body", `HTTP 202 · original run ${first.body.run.id}`);
const changed = await sendMessage(
  api,
  conversation.body.id,
  "changed body",
  "opencode-demo-first",
);
requireStatus(changed.status, 409, "changed idempotency body");
line("Same key + changed body (expected rejection)", "HTTP 409");
const busy = await sendMessage(
  api,
  conversation.body.id,
  "Concurrent prompt must not start",
  "opencode-demo-busy",
);
requireStatus(busy.status, 409, "concurrent message");
line("Concurrent message (expected rejection)", "HTTP 409");
const firstRun = await wait(first.body.run.id);
if (
  firstRun.status !== "completed" ||
  typeof firstRun.output !== "string" ||
  firstRun.output.trim().length < 80
)
  throw new Error(
    `First run ${firstRun.status}: ${firstRun.error?.message ?? "assistant reply was too short"}`,
  );
line("Real assistant reply", `run ${firstRun.id} · completed`);
console.log(`  ${firstRun.output.trim().replaceAll("\n", "\n  ")}`);
const messages = await api.conversations.listMessages({
  params: { conversationId: conversation.body.id },
  query: { limit: 25 },
});
requireStatus(messages.status, 200, "listMessages");
if (
  messages.status !== 200 ||
  messages.body.items.length !== 2 ||
  messages.body.items[1]?.role !== "assistant" ||
  messages.body.items[1].content !== firstRun.output
)
  throw new Error("Expected the real assistant reply in conversation messages");
line("Conversation messages", "HTTP 200 · user prompt and assistant reply");
const firstEvents = await api.runs.listEvents({
  params: { runId: first.body.run.id },
  query: { after: 0, limit: 100 },
});
requireStatus(firstEvents.status, 200, "first run events");
if (
  firstEvents.status !== 200 ||
  !firstEvents.body.some((event) => event.type === "agent.assistant") ||
  firstEvents.body.some(
    (event, i, events) => i > 0 && event.sequence <= events[i - 1]!.sequence,
  )
)
  throw new Error("First run did not contain ordered assistant events");
line(
  "Run events",
  firstEvents.body
    .map((event) => `${event.sequence}:${event.type}`)
    .join(" → "),
);

title(5, "Continue the conversation in the same agent session");
const second = await sendMessage(
  api,
  conversation.body.id,
  "What was the release tag I provided? Include it and suggest one verification step before releasing the checkout fix.",
  "opencode-demo-second",
);
requireStatus(second.status, 202, "second sendMessage");
if (second.status !== 202) throw new Error("Missing continuation run");
const secondRun = await wait(second.body.run.id);
if (
  secondRun.status !== "completed" ||
  typeof secondRun.output !== "string" ||
  !secondRun.output.includes(marker)
)
  throw new Error(
    `Second run did not recall the release tag: ${secondRun.error?.message ?? secondRun.output}`,
  );
line("Continuation reply", `run ${secondRun.id} · completed`);
console.log(`  ${secondRun.output.trim().replaceAll("\n", "\n  ")}`);
const secondEvents = await api.runs.listEvents({
  params: { runId: second.body.run.id },
  query: { after: 0, limit: 100 },
});
requireStatus(secondEvents.status, 200, "continuation events");
if (
  secondEvents.status !== 200 ||
  secondEvents.body.some(
    (event, i, events) => i > 0 && event.sequence <= events[i - 1]!.sequence,
  ) ||
  !secondEvents.body.some(
    (event) => event.type === "agent.session" && event.data?.resumed === true,
  )
)
  throw new Error("OpenCode did not confirm ordered session continuation");
line("Agent session", "resumed · release tag recalled");
line(
  "Continuation events",
  secondEvents.body
    .map((event) => `${event.sequence}:${event.type}`)
    .join(" → "),
);

title(6, "Verify expected API rejections and example scope");
const unauthenticated = await fetch(`${base}/api/v1/conversations`);
requireStatus(unauthenticated.status, 401, "missing bearer token");
const wrongToken = await fetch(`${base}/api/v1/conversations`, {
  headers: { authorization: "Bearer wrong-token" },
});
requireStatus(wrongToken.status, 401, "wrong bearer token");
const unauthenticatedStatus = await fetch(`${base}/api/v1/status`);
requireStatus(unauthenticatedStatus.status, 401, "unauthenticated status");
line("Missing/wrong bearer token (expected rejection)", "HTTP 401");
const badContent = await fetch(
  `${base}/api/v1/conversations/${conversation.body.id}/messages`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: [{ type: "text", text: "part" }] }),
  },
);
requireStatus(badContent.status, 400, "unsupported content parts");
const unknownAgent = await api.conversations.createConversation({
  body: { agentId: "unsupported-agent" },
});
requireStatus(unknownAgent.status, 400, "unsupported agent");
const unsupportedProject = await api.conversations.createConversation({
  body: { projectId: "unsupported-project" },
});
requireStatus(
  unsupportedProject.status,
  400,
  "unsupported project association",
);
line("Unsupported content/agent/project (expected rejection)", "HTTP 400");
const unknown = await api.conversations.getConversation({
  params: { conversationId: "missing-conversation" },
});
requireStatus(unknown.status, 404, "unknown conversation");
const unknownRun = await api.runs.getRun({ params: { runId: "missing-run" } });
requireStatus(unknownRun.status, 404, "unknown run");
line("Unknown conversation/run (expected rejection)", "HTTP 404");
const unsupported = await api.projects.listProjects({ query: { limit: 1 } });
requireStatus(unsupported.status, 501, "unimplemented project listing");
const fallback = unsupported.body;
if (
  typeof fallback !== "object" ||
  fallback === null ||
  !("error" in fallback) ||
  typeof fallback.error !== "object" ||
  fallback.error === null ||
  !("code" in fallback.error) ||
  fallback.error.code !== "not_implemented"
)
  throw new Error("Unsupported route did not return a typed 501");
line("Unimplemented project listing (expected fallback)", "HTTP 501");

console.log(
  `\n${color(32, "✓ Demo complete")} · Real Big Pickle replies, authenticated HTTP contract, and resumed session verified.\n`,
);
