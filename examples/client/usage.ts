import { createClient, sendMessage, startRun } from "./src/index.js";
const api = createClient(
  process.env.API_URL ?? "http://127.0.0.1:3091",
  process.env.API_TOKEN ?? "dev-token",
);
const conversation = await api.conversations.createConversation({
  body: {},
});
if (conversation.status === 201) {
  const sent = await sendMessage(
    api,
    conversation.body.id,
    "Review this proposal",
  );
  if (sent.status === 202) console.log("Chat run:", sent.body.run.id);
  const continued = await startRun(api, {
    conversationId: conversation.body.id,
    input: "Continue from our last message",
  });
  if (continued.status === 202)
    console.log("Continued run:", continued.body.run.id);
} else console.log("Conversation backend is not installed yet.");

const started = await startRun(api, { input: "Summarize this project" });
if (started.status === 202) {
  console.log("Agent run:", started.body.run.id);
  const finished = await api.runs.getRun({
    params: { runId: started.body.run.id },
  });
  if (finished.status === 200) console.log("Answer:", finished.body.run.output);
  const interaction = started.body.interactions?.find(
    (item) => item.status === "pending",
  );
  if (
    interaction &&
    (!interaction.decisions || interaction.decisions.includes("approve"))
  ) {
    await api.interactions.submitInteractionDecision({
      params: { interactionId: interaction.id },
      body: { decision: "approve" },
    });
  }
}

const pending = await api.interactions.listPendingInteractions({
  query: { limit: 25 },
});
if (pending.status === 200 && pending.body.items[0]) {
  const interaction = pending.body.items[0];
  await api.interactions.submitInteractionDecision({
    params: { interactionId: interaction.id },
    body: { decision: "approve" },
  });
}

const definitions = await api.workflows.listWorkflows({
  query: { limit: 25 },
});
if (definitions.status === 200 && definitions.body.items[0]) {
  const workflow = await startRun(api, {
    target: { kind: "workflow", workflowId: definitions.body.items[0].id },
    input: "Run the review workflow",
  });
  if (workflow.status === 202)
    console.log("Workflow run:", workflow.body.run.id);
}
