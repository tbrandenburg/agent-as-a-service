import { createApp } from "../server-express/src/index.js";
import { createDemoImplementation } from "../server-express/src/adapters/demo.js";
import { once } from "node:events";
import { createClient, sendMessage, startRun } from "./src/index.js";

const color = (code: number, value: string) =>
  process.stdout.isTTY ? `\u001b[${code}m${value}\u001b[0m` : value;
const title = (number: number, label: string) =>
  console.log(
    `\n${color(36, `━━ ${String(number).padStart(2, "0")}  ${label} ━━`)}`,
  );
const line = (label: string, value: unknown) =>
  console.log(
    `  ${color(32, "✓")} ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
const requireStatus = (actual: number, wanted: number, operation: string) => {
  if (actual !== wanted)
    throw new Error(`${operation}: expected HTTP ${wanted}, got ${actual}`);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const app = createApp({
  token: "demo-token",
  implementation: createDemoImplementation(),
});
let server: ReturnType<typeof app.listen> | undefined;
try {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Demo server has no TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = createClient(baseUrl, "demo-token");
  console.log(color(1, "Agent as a Service  ·  simulated end-to-end demo"));
  console.log(`Using a temporary in-memory Express server on ${baseUrl}`);

  title(1, "Check access and configuration");
  const denied = await fetch(`${baseUrl}/api/v1/projects`);
  requireStatus(denied.status, 401, "unauthenticated projects");
  line("Unauthenticated request", "HTTP 401");
  const status = await api.system.getStatus();
  requireStatus(status.status, 200, "getStatus");
  if (status.status !== 200) throw new Error("Missing status response");
  line(
    "Authenticated status",
    status.body.environment
      .map((item) => `${item.name}=${item.set ? "set" : "unset"}`)
      .join(", "),
  );

  title(2, "Create a coding project");
  const project = await api.projects.createProject({
    body: {
      name: "Payments API",
      repositoryUrl: "https://github.com/example/payments",
    },
  });
  requireStatus(project.status, 201, "createProject");
  if (project.status !== 201) throw new Error("Missing project");
  line(
    "POST /api/v1/projects",
    `HTTP 201 · ${project.body.name} · ${project.body.id}`,
  );

  title(3, "Open a conversation with the default agent");
  const conversation = await api.conversations.createConversation({
    body: { projectId: project.body.id, title: "Review the checkout change" },
  });
  requireStatus(conversation.status, 201, "createConversation");
  if (conversation.status !== 201) throw new Error("Missing conversation");
  line(
    "Conversation",
    `${conversation.body.id} · agent ${conversation.body.target?.id}`,
  );

  title(4, "Send a message and check immediate run visibility");
  const prompt = "Can you review the checkout change?";
  const messageKey = "demo-message-001";
  const sent = await sendMessage(api, conversation.body.id, prompt, messageKey);
  requireStatus(sent.status, 202, "sendMessage");
  if (sent.status !== 202) throw new Error("Missing accepted message");
  const chatRunId = sent.body.run.id;
  const immediate = await api.runs.getRun({ params: { runId: chatRunId } });
  requireStatus(immediate.status, 200, "getRun immediately after 202");
  if (
    immediate.status !== 200 ||
    immediate.body.conversations?.[0]?.conversationId !== conversation.body.id
  )
    throw new Error("Chat run did not expose its public conversation");
  line("Accepted message", `${sent.body.message.id} · HTTP 202`);
  line("GET /runs/{runId} immediately", `HTTP 200 · ${chatRunId}`);

  title(5, "Retry safely, then read the assistant reply");
  const replay = await sendMessage(
    api,
    conversation.body.id,
    prompt,
    messageKey,
  );
  requireStatus(replay.status, 202, "idempotent message retry");
  if (replay.status !== 202 || replay.body.run.id !== chatRunId)
    throw new Error("Retry duplicated chat work");
  const changed = await sendMessage(
    api,
    conversation.body.id,
    "A different prompt",
    messageKey,
  );
  requireStatus(changed.status, 409, "changed idempotent request");
  line("Same key + same body", `HTTP 202 · original run ${chatRunId}`);
  line("Same key + changed body", "HTTP 409 idempotency_conflict");
  for (let attempt = 0; attempt < 60; attempt++) {
    const run = await api.runs.getRun({ params: { runId: chatRunId } });
    if (run.status === 200 && run.body.run.status === "completed") break;
    if (attempt === 59) throw new Error("Chat did not complete");
    await pause(25);
  }
  const messages = await api.conversations.listMessages({
    params: { conversationId: conversation.body.id },
    query: { limit: 25 },
  });
  requireStatus(messages.status, 200, "listMessages");
  if (messages.status !== 200 || messages.body.items.length !== 2)
    throw new Error("Expected one user message and one assistant reply");
  line("Assistant", messages.body.items[1].content);
  const chatEvents = await api.runs.listEvents({
    params: { runId: chatRunId },
    query: { after: 0, limit: 25 },
  });
  requireStatus(chatEvents.status, 200, "listEvents for agent run");
  if (chatEvents.status !== 200) throw new Error("Missing agent events");
  line("Simulated agent provider", conversation.body.target?.id);
  line(
    "Provider stream",
    `${chatEvents.body.filter((event) => event.type === "agent.assistant").length} text chunks → assistant message`,
  );
  const continued = await sendMessage(
    api,
    conversation.body.id,
    "Continue with the next step",
  );
  requireStatus(continued.status, 202, "continue conversation");
  if (continued.status !== 202) throw new Error("Missing continuation run");
  for (let attempt = 0; attempt < 60; attempt++) {
    const run = await api.runs.getRun({
      params: { runId: continued.body.run.id },
    });
    if (run.status === 200 && run.body.run.status === "completed") break;
    if (attempt === 59) throw new Error("Continuation did not complete");
    await pause(25);
  }
  const continuedEvents = await api.runs.listEvents({
    params: { runId: continued.body.run.id },
    query: { after: 0, limit: 25 },
  });
  requireStatus(continuedEvents.status, 200, "continuation events");
  if (
    continuedEvents.status !== 200 ||
    !continuedEvents.body.some(
      (event) => event.type === "agent.session" && event.data?.resumed === true,
    )
  )
    throw new Error("Provider did not resume the conversation session");
  line("Next message", "provider resumed its previous session");

  title(6, "Discover and start a review workflow");
  const definitions = await api.workflows.listWorkflows({
    query: { limit: 25 },
  });
  requireStatus(definitions.status, 200, "listWorkflows");
  if (definitions.status !== 200 || !definitions.body.items[0])
    throw new Error("No demo workflow");
  const workflow = definitions.body.items[0];
  const started = await startRun(
    api,
    {
      projectId: project.body.id,
      conversationId: conversation.body.id,
      target: { kind: "workflow", id: workflow.id },
      input: "Review the checkout change for release",
    },
    "demo-workflow-001",
  );
  requireStatus(started.status, 202, "startRun");
  if (started.status !== 202) throw new Error("Missing workflow run");
  const reviewRunId = started.body.run.id;
  const review = await api.runs.getRun({ params: { runId: reviewRunId } });
  requireStatus(review.status, 200, "getRun for workflow conversation links");
  if (
    review.status !== 200 ||
    review.body.conversations?.[0]?.conversationId !== conversation.body.id
  )
    throw new Error("Workflow run did not expose its public conversation");
  const linked = await api.conversations.getConversation({
    params: { conversationId: review.body.conversations[0].conversationId },
  });
  requireStatus(linked.status, 200, "getConversation for run link");
  const linkedMessages = await api.conversations.listMessages({
    params: { conversationId: review.body.conversations[0].conversationId },
    query: { limit: 25 },
  });
  requireStatus(linkedMessages.status, 200, "listMessages for run link");
  line("Selected workflow", `${workflow.name} · ${workflow.id}`);
  line("Run accepted", `${reviewRunId} · HTTP 202`);
  line("Public conversation link", review.body.conversations[0].conversationId);

  title(7, "Watch the run pause for human approval");
  for (let attempt = 0; attempt < 60; attempt++) {
    const run = await api.runs.getRun({ params: { runId: reviewRunId } });
    if (run.status === 200 && run.body.run.status === "paused") break;
    if (attempt === 59) throw new Error("Workflow did not request approval");
    await pause(25);
  }
  const pending = await api.interactions.listPendingInteractions({
    query: { projectId: project.body.id, limit: 25 },
  });
  requireStatus(pending.status, 200, "listPendingInteractions");
  if (pending.status !== 200 || !pending.body.items[0])
    throw new Error("Missing approval request");
  const interaction = pending.body.items[0];
  line("Approval", `${interaction.prompt} · ${interaction.id}`);
  line("Offered decisions", interaction.decisions);

  title(8, "Approve and let the workflow finish");
  const decision = await api.interactions.submitInteractionDecision({
    params: { interactionId: interaction.id },
    headers: { "idempotency-key": "demo-approval-001" },
    body: { decision: "approve", comment: "Looks good for the demo" },
  });
  requireStatus(decision.status, 200, "submitInteractionDecision");
  const decisionReplay = await api.interactions.submitInteractionDecision({
    params: { interactionId: interaction.id },
    headers: { "idempotency-key": "demo-approval-001" },
    body: { decision: "approve", comment: "Looks good for the demo" },
  });
  requireStatus(decisionReplay.status, 200, "idempotent decision retry");
  line("Decision", "approve · HTTP 200 (safe retry also HTTP 200)");
  for (let attempt = 0; attempt < 60; attempt++) {
    const run = await api.runs.getRun({ params: { runId: reviewRunId } });
    if (run.status === 200 && run.body.run.status === "completed") {
      line("Run", `${run.body.run.status} · ${run.body.run.output}`);
      break;
    }
    if (attempt === 59) throw new Error("Approved workflow did not finish");
    await pause(25);
  }

  title(9, "Inspect events and the produced artifact");
  const events = await api.runs.listEvents({
    params: { runId: reviewRunId },
    query: { after: 0, limit: 100 },
  });
  requireStatus(events.status, 200, "listEvents");
  const artifacts = await api.runs.listArtifacts({
    params: { runId: reviewRunId },
  });
  requireStatus(artifacts.status, 200, "listArtifacts");
  if (events.status !== 200 || artifacts.status !== 200 || !artifacts.body[0])
    throw new Error("Missing run events or artifact");
  const content = await api.runs.getArtifact({
    params: { runId: reviewRunId, artifactId: artifacts.body[0].id },
  });
  requireStatus(content.status, 200, "getArtifact");
  if (content.status !== 200) throw new Error("Missing report");
  line(
    "Event order",
    events.body.map((event) => `${event.sequence}:${event.type}`).join(" → "),
  );
  line(
    "Artifact",
    `${artifacts.body[0].name} · ${artifacts.body[0].sizeBytes} bytes`,
  );
  console.log(
    `  ${color(32, "✓")} Report preview: ${Buffer.from(content.body.contentBase64, "base64").toString("utf8").trim().replaceAll("\n", " | ")}`,
  );

  console.log(
    `\n${color(32, "✓ Demo complete")} · State was in memory and disappears when this process exits.\n`,
  );
} finally {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
}
