import { createClient, sendMessage } from "../../client/src/index.js";

const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS ?? 300_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
  throw new Error("OPENCODE_TIMEOUT_MS must be a positive integer");
const token = process.env.API_TOKEN;
if (!token?.trim()) throw new Error("API_TOKEN must be supplied");
const base = process.env.DEMO_BASE_URL;
if (!base || !/^https?:\/\//.test(base))
  throw new Error("DEMO_BASE_URL must be supplied as an HTTP(S) URL");
const api = createClient(base, token);
console.log(`Docker OpenCode HTTP demo · url=${base} · timeout=${timeoutMs}ms`);
const health = await fetch(`${base}/api/v1/health`);
if (health.status !== 200) throw new Error(`Health returned ${health.status}`);
const openapi = await fetch(`${base}/api/v1/openapi.json`);
if (openapi.status !== 200)
  throw new Error(`OpenAPI returned ${openapi.status}`);
const openapiDocument = (await openapi.json()) as { paths?: unknown };
if (!openapiDocument.paths || Object.keys(openapiDocument.paths).length < 22)
  throw new Error("OpenAPI document did not expose the contract paths");
const unauthenticated = await fetch(`${base}/api/v1/conversations`);
if (unauthenticated.status !== 401)
  throw new Error("Unauthenticated request was not rejected");
const wrongToken = await fetch(`${base}/api/v1/conversations`, {
  headers: { authorization: "Bearer wrong-token" },
});
if (wrongToken.status !== 401)
  throw new Error("Wrong bearer token was not rejected");
const unauthenticatedStatus = await fetch(`${base}/api/v1/status`);
if (unauthenticatedStatus.status !== 401)
  throw new Error("Unauthenticated status request was not rejected");
const status = await api.system.getStatus();
if (status.status !== 200) throw new Error(`Status returned ${status.status}`);
const conversation = await api.conversations.createConversation({
  body: { title: "OpenCode session demo" },
});
if (conversation.status !== 201)
  throw new Error(`createConversation returned ${conversation.status}`);
const firstFact = `The session marker is ${Math.random().toString(36).slice(2, 9)}`;
const first = await sendMessage(
  api,
  conversation.body.id,
  `Remember this exact marker: ${firstFact}. Reply with the marker.`,
  "opencode-demo-first",
);
if (first.status !== 202)
  throw new Error(`first message returned ${first.status}`);
const immediate = await api.runs.getRun({
  params: { runId: first.body.run.id },
});
if (immediate.status !== 200)
  throw new Error("Accepted run was not immediately readable");
const replay = await sendMessage(
  api,
  conversation.body.id,
  `Remember this exact marker: ${firstFact}. Reply with the marker.`,
  "opencode-demo-first",
);
if (
  replay.status !== 202 ||
  replay.body.run.id !== first.body.run.id ||
  replay.body.message.id !== first.body.message.id
)
  throw new Error("Idempotent retry did not replay the original acceptance");
const changed = await sendMessage(
  api,
  conversation.body.id,
  "changed body",
  "opencode-demo-first",
);
if (changed.status !== 409)
  throw new Error("Changed idempotency body did not return HTTP 409");
const busy = await sendMessage(
  api,
  conversation.body.id,
  "Concurrent prompt must not start",
  "opencode-demo-busy",
);
if (busy.status !== 409)
  throw new Error("Concurrent different message did not return HTTP 409");
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
if (badContent.status !== 400)
  throw new Error("Content parts were not rejected with HTTP 400");
const unknown = await api.conversations.getConversation({
  params: { conversationId: "missing-conversation" },
});
if (unknown.status !== 404)
  throw new Error("Unknown conversation did not return HTTP 404");
const unknownRun = await api.runs.getRun({
  params: { runId: "missing-run" },
});
if (unknownRun.status !== 404)
  throw new Error("Unknown run did not return HTTP 404");
const unknownAgent = await api.conversations.createConversation({
  body: { agentId: "unsupported-agent" },
});
if (unknownAgent.status !== 400)
  throw new Error("Unsupported agent did not return HTTP 400");
const unsupportedProject = await api.conversations.createConversation({
  body: { projectId: "unsupported-project" },
});
if (unsupportedProject.status !== 400)
  throw new Error("Unsupported project did not return HTTP 400");
const unsupported = await api.projects.listProjects({ query: { limit: 1 } });
if (unsupported.status !== 501)
  throw new Error("Unsupported route did not return HTTP 501");
console.log(
  "HTTP checks: health/OpenAPI 200 · status 200 authenticated/401 anonymous · missing/wrong token 401 · changed key/active conflict 409 · content/agent/project 400 · unknown conversation/run 404 · unsupported 501",
);
const wait = async (runId: string) => {
  const deadline = Date.now() + timeoutMs + 15_000;
  while (Date.now() < deadline) {
    const result = await api.runs.getRun({ params: { runId } });
    if (result.status !== 200)
      throw new Error(`getRun returned ${result.status}`);
    if (["completed", "failed"].includes(result.body.run.status))
      return result.body.run;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Run ${runId} exceeded demo polling deadline`);
};
const firstRun = await wait(first.body.run.id);
if (
  firstRun.status !== "completed" ||
  typeof firstRun.output !== "string" ||
  !firstRun.output.trim()
)
  throw new Error(
    `First run ${firstRun.status}: ${firstRun.error?.message ?? "empty response"}`,
  );
const firstEvents = await api.runs.listEvents({
  params: { runId: first.body.run.id },
  query: { after: 0, limit: 100 },
});
if (
  firstEvents.status !== 200 ||
  firstEvents.body.some(
    (event, i, events) => i > 0 && event.sequence <= events[i - 1]!.sequence,
  )
)
  throw new Error("First run events are not in increasing sequence order");
const second = await sendMessage(
  api,
  conversation.body.id,
  `What exact marker did I ask you to remember? Reply with only that marker.`,
  "opencode-demo-second",
);
if (second.status !== 202)
  throw new Error(`second message returned ${second.status}`);
const secondRun = await wait(second.body.run.id);
if (
  secondRun.status !== "completed" ||
  typeof secondRun.output !== "string" ||
  !secondRun.output.includes(firstFact.split(" ").at(-1)!)
)
  throw new Error(
    `Second run did not recall the marker: ${secondRun.error?.message ?? secondRun.output}`,
  );
const secondEvents = await api.runs.listEvents({
  params: { runId: second.body.run.id },
  query: { after: 0, limit: 100 },
});
if (
  secondEvents.status !== 200 ||
  !secondEvents.body.some(
    (event) => event.type === "agent.session" && event.data?.resumed === true,
  )
)
  throw new Error("OpenCode did not confirm session continuation");
console.log(
  `Accepted/readable run: ${first.body.run.id}; assistant: ${firstRun.output}`,
);
console.log(
  `Continuation confirmed: ${second.body.run.id}; assistant: ${secondRun.output}`,
);
console.log(
  `Event sequences: ${firstEvents.body.map(({ sequence }) => sequence).join(", ")} → ${secondEvents.body.map(({ sequence }) => sequence).join(", ")}`,
);
