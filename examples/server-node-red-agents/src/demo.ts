import { createClient, startRun } from "../../client/src/index.js";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error("DEMO_BASE_URL and API_TOKEN required");
const api = createClient(base, token);
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
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
