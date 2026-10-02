import assert from "node:assert/strict";
import { createClient, startRun } from "../../client/src/index.js";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error("DEMO_BASE_URL and API_TOKEN required");
if (process.env.DEFAULT_MODEL !== "github-copilot/gpt-6-luna")
  throw new Error(
    "Use DEFAULT_MODEL=github-copilot/gpt-6-luna for provider acceptance",
  );
const api = createClient(base, token);
const core = await api.workflows.getWorkflow({
  params: { workflowId: "core" },
});
assert.equal(core.status, 200);
if (core.status !== 200) throw new Error("Core lookup failed");
assert.equal(core.body.readOnly, true);
assert.equal(core.body.version, 1);
const listed = await api.workflows.listWorkflows({ query: { limit: 100 } });
assert.equal(listed.status, 200);
if (listed.status === 200)
  assert.equal(
    listed.body.items.filter((workflow) => workflow.id === "core").length,
    1,
  );
assert.equal(
  (await api.workflows.deleteWorkflow({ params: { workflowId: "core" } }))
    .status,
  403,
);
assert.equal(
  (
    await api.workflows.updateWorkflow({
      params: { workflowId: "core" },
      body: {
        engine: core.body.engine,
        specification: core.body.specification,
      },
    })
  ).status,
  403,
);
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
      if (
        !result.body.executions?.some(
          (execution) => execution.key === "orchestrator",
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      assert.equal(result.body.conversations?.length, 1);
      const link = result.body.conversations![0];
      const messages = await api.conversations.listMessages({
        params: { conversationId: link.conversationId },
        query: { limit: 10 },
      });
      assert.equal(messages.status, 200);
      if (messages.status === 200) {
        assert.ok(
          messages.body.items.some((message) => message.role === "user"),
        );
        assert.ok(
          messages.body.items.some((message) => message.role === "assistant"),
        );
      }
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
      target: { kind: "workflow", id: "core" },
      input: { text },
    }),
  ),
);
for (const response of accepted) {
  assert.equal(response.status, 202);
  if (response.status !== 202) throw new Error("Workflow run rejected");
  const result = await poll(response.body.run.id);
  assert.equal(result.conversations![0].nodeId, "orchestrator");
  assert.ok(
    result.executions?.some((execution) => execution.key === "orchestrator"),
  );
}
const project = await api.projects.createProject({
  body: { name: "Core project acceptance" },
});
assert.equal(project.status, 201);
if (project.status !== 201) throw new Error("Project create failed");
const bootstrap = await startRun(api, {
  projectId: project.body.id,
  target: { kind: "workflow", id: "core" },
  input: {
    text: "Run pwd and include its exact output in your reply.",
  },
});
assert.equal(bootstrap.status, 202);
if (bootstrap.status !== 202) throw new Error("Core run rejected");
const first = await poll(bootstrap.body.run.id);
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
  `Deleted terminal Core run=${first.run.id}; conversation=${conversationId} and history retained`,
);
assert.equal(
  (
    await startRun(api, {
      conversationId,
      target: { kind: "workflow", id: "core" },
      input: { text: "Resume elsewhere" },
    })
  ).status,
  501,
);
assert.equal(
  (
    await startRun(api, {
      target: { kind: "agent", id: "orchestrator" },
      input: { text: "Unsupported" },
    })
  ).status,
  501,
);
assert.equal(
  (await api.projects.deleteProject({ params: { projectId: project.body.id } }))
    .status,
  200,
);
console.log(
  "Real Core workflows, orchestrator observation, project cwd and history retention passed",
);
