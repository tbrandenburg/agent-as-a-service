import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient, startRun } from "../../client/src/index.js";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error("DEMO_BASE_URL and API_TOKEN required");
if (process.env.DEFAULT_MODEL !== "github-copilot/gpt-6-luna")
  throw new Error(
    "Use DEFAULT_MODEL=github-copilot/gpt-6-luna for provider acceptance",
  );
const api = createClient(base, token);
const flows: Record<string, unknown>[] = JSON.parse(
  await readFile(new URL("../node-red/flows.json", import.meta.url), "utf8"),
);
const created = await api.workflows.createWorkflow({
  body: {
    name: "Native agent",
    engine: "node-red",
    specification: { entry: "workflow-in", flows },
  },
});
assert.equal(created.status, 201);
if (created.status !== 201) throw new Error("Workflow create failed");
const poll = async (id: string) => {
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    const result = await api.runs.getRun({ params: { runId: id } });
    assert.equal(result.status, 200);
    if (
      result.status === 200 &&
      ["completed", "failed"].includes(result.body.run.status)
    ) {
      assert.equal(
        result.body.run.status,
        "completed",
        `Run ${id}: ${result.body.run.error?.code}`,
      );
      assert.equal(typeof result.body.run.output, "string");
      assert.ok(result.body.run.output);
      assert.equal(result.body.conversations?.length, 1);
      const link = result.body.conversations![0];
      const messages = await api.conversations.listMessages({
        params: { conversationId: link.conversationId },
        query: { limit: 10 },
      });
      assert.equal(messages.status, 200);
      if (messages.status === 200)
        assert.ok(
          messages.body.items.some((message) => message.role === "assistant"),
        );
      console.log(
        `Provider run=${id} status=completed version=${result.body.run.workflowVersion ?? "-"} conversation=${link.conversationId}`,
      );
      return result.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Run ${id} exceeded deadline`);
};
const prompts = [
  "In one sentence, draft a release note about a faster search index.",
  "In one sentence, draft a release note about clearer navigation.",
];
const accepted = await Promise.all(
  prompts.map((text) =>
    startRun(api, {
      target: { kind: "workflow", id: created.body.id },
      input: { text },
    }),
  ),
);
for (const response of accepted) {
  assert.equal(response.status, 202);
  if (response.status !== 202) throw new Error("Workflow run rejected");
  const result = await poll(response.body.run.id);
  assert.equal(result.conversations![0].nodeId, "core-agent");
  assert.ok(
    result.executions?.some((execution) => execution.key === "core-agent"),
  );
}
const project = await api.projects.createProject({
  body: { name: "Direct session acceptance" },
});
assert.equal(project.status, 201);
if (project.status !== 201) throw new Error("Project create failed");
const direct = await startRun(api, {
  projectId: project.body.id,
  target: { kind: "agent", id: "writer-agent" },
  input: {
    text: "Run pwd and include its exact output in your reply. Remember the word juniper.",
  },
});
assert.equal(direct.status, 202);
if (direct.status !== 202) throw new Error("Direct run rejected");
const first = await poll(direct.body.run.id);
assert.ok(
  typeof first.run.output === "string" &&
    first.run.output.includes(project.body.localPath!),
);
const conversationId = first.conversations![0].conversationId;
assert.equal(
  (await api.runs.deleteRun({ params: { runId: first.run.id } })).status,
  200,
);
assert.equal(
  (await api.runs.getRun({ params: { runId: first.run.id } })).status,
  404,
);
assert.equal(
  (await api.conversations.getConversation({ params: { conversationId } }))
    .status,
  200,
);
const history = await api.conversations.listMessages({
  params: { conversationId },
  query: { limit: 100 },
});
assert.equal(history.status, 200);
if (history.status === 200) {
  assert.ok(history.body.items.some((message) => message.role === "user"));
  assert.ok(history.body.items.some((message) => message.role === "assistant"));
}
console.log(
  `Deleted terminal direct run=${first.run.id}; conversation=${conversationId} and history retained`,
);
const continued = await startRun(api, {
  projectId: project.body.id,
  conversationId,
  target: { kind: "agent", id: "writer-agent" },
  input: { text: "What word did I ask you to remember?" },
});
assert.equal(continued.status, 202);
if (continued.status !== 202) throw new Error("Continuation rejected");
const second = await poll(continued.body.run.id);
assert.equal(second.conversations![0].conversationId, conversationId);
assert.ok(
  typeof second.run.output === "string" &&
    second.run.output.toLowerCase().includes("juniper"),
);
const events = await api.runs.listEvents({
  params: { runId: second.run.id },
  query: { after: 0, limit: 100 },
});
assert.equal(events.status, 200);
if (events.status === 200)
  assert.ok(
    events.body.some(
      (event) =>
        event.type === "execution.terminal" && event.data?.resumed === true,
    ),
  );
assert.equal(
  (
    await startRun(api, {
      conversationId,
      target: { kind: "agent", id: "writer-agent" },
      input: { text: "Resume elsewhere" },
    })
  ).status,
  409,
);
assert.equal(
  (
    await api.workflows.deleteWorkflow({
      params: { workflowId: created.body.id },
    })
  ).status,
  200,
);
assert.equal(
  (await api.projects.deleteProject({ params: { projectId: project.body.id } }))
    .status,
  200,
);
console.log(
  "Real native agent workflows, observation, project cwd and direct-session continuation passed",
);
