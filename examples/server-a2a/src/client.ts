import { randomUUID } from "node:crypto";
import {
  ClientFactory,
  ClientFactoryOptions,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";

const url = process.env.A2A_URL ?? "http://127.0.0.1:3095";
const token = process.env.A2A_TOKEN;
if (!token) throw new Error("A2A_TOKEN is required");
const transport = new RestTransportFactory({
  fetchImpl: (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...init?.headers, authorization: `Bearer ${token}` },
    }),
});
const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [transport],
  }),
);
const client = await factory.createFromUrl(url);
const sent = (message: { text?: string; data?: unknown }) => ({
  messageId: randomUUID(),
  contextId: "",
  taskId: "",
  role: Role.ROLE_USER,
  parts: [
    message.text === undefined
      ? {
          content: { $case: "data" as const, value: message.data },
          mediaType: "application/json",
          metadata: undefined,
          filename: "",
        }
      : {
          content: { $case: "text" as const, value: message.text },
          mediaType: "text/plain",
          metadata: undefined,
          filename: "",
        },
  ],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});
const catalogue = await client.sendMessage({
  message: sent({ text: "list workflows" }),
  tenant: "",
  configuration: {
    acceptedOutputModes: ["application/json"],
    returnImmediately: true,
    taskPushNotificationConfig: undefined,
  },
  metadata: undefined,
});
if (!("parts" in catalogue)) throw new Error("Workflow discovery failed");
writeEvidence({
  type: "request",
  operation: "workflows.list",
  input: "list workflows",
});
const workflowPart = catalogue.parts.find(
  (part) => part.content?.$case === "data",
);
const workflowData =
  workflowPart?.content?.$case === "data"
    ? workflowPart.content.value
    : undefined;
if (!isRecord(workflowData) || !Array.isArray(workflowData.workflows))
  throw new Error("Invalid workflow catalogue response");
const workflows = workflowData.workflows.filter(isRecord);
writeEvidence({
  type: "response",
  operation: "workflows.list",
  workflows: workflows.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
  })),
});
process.stdout.write(`Discovered ${workflows.length} workflows\n`);
for (const workflow of workflows)
  process.stdout.write(`- ${String(workflow.name)} (${String(workflow.id)})\n`);

const invalid = await client.sendMessage({
  message: sent({ data: { operation: "unknown.operation", parameters: {} } }),
  tenant: "",
  configuration: {
    acceptedOutputModes: ["application/json"],
    returnImmediately: true,
    taskPushNotificationConfig: undefined,
  },
  metadata: undefined,
});
writeEvidence({
  type: "request",
  operation: "unsupported",
  input: { operation: "unknown.operation", parameters: {} },
});
if (!("parts" in invalid))
  throw new Error("Unsupported operation was not rejected");
writeEvidence({
  type: "response",
  operation: "unsupported",
  message:
    invalid.parts[0]?.content?.$case === "text"
      ? invalid.parts[0].content.value
      : "unexpected response",
});
process.stdout.write(
  "Unsupported operation returned a protocol-valid message\n",
);
try {
  writeEvidence({
    type: "request",
    operation: "tasks.get",
    taskId: "missing-task",
  });
  await client.getTask({ id: "missing-task", tenant: "" });
  throw new Error("Unknown Task unexpectedly resolved");
} catch (error) {
  if (
    error instanceof Error &&
    error.message === "Unknown Task unexpectedly resolved"
  )
    throw error;
  process.stdout.write("Unknown Task was rejected\n");
}

const workflowId =
  process.env.A2A_WORKFLOW_ID ?? findWorkflow(workflows, "multiply");
const completed = await client.sendMessage({
  message: sent({
    data: {
      operation: "workflows.execute",
      parameters: { workflowId, input: { a: 13.75, b: -8 } },
    },
  }),
  tenant: "",
  configuration: {
    acceptedOutputModes: ["application/json"],
    returnImmediately: true,
    taskPushNotificationConfig: undefined,
  },
  metadata: undefined,
});
writeEvidence({
  type: "request",
  operation: "workflows.execute",
  workflowId,
  input: { a: 13.75, b: -8 },
});
if (!("id" in completed))
  throw new Error("Workflow execution did not return an A2A Task");
writeEvidence({
  type: "response",
  operation: "workflows.execute",
  taskId: completed.id,
  contextId: completed.contextId,
  state: completed.status?.state,
});
const finalTask = await waitForTask(client, completed);
if (finalTask.status?.state !== TaskState.TASK_STATE_COMPLETED)
  throw new Error("Workflow did not complete successfully");
const output = finalTask.artifacts[0]?.parts[0]?.content;
if (output?.$case !== "data" || output.value !== -110)
  throw new Error("Expected structured numeric output -110");
writeEvidence({
  type: "response",
  operation: "tasks.get",
  taskId: finalTask.id,
  contextId: finalTask.contextId,
  state: finalTask.status?.state,
  artifact: output.value,
});
process.stdout.write(
  `Task ${finalTask.id} completed with structured output -110\n`,
);

const cancelWorkflowId = process.env.A2A_CANCEL_WORKFLOW_ID;
if (cancelWorkflowId) {
  const pending = await client.sendMessage({
    message: sent({
      data: {
        operation: "workflows.execute",
        parameters: { workflowId: cancelWorkflowId, input: {} },
      },
    }),
    tenant: "",
    configuration: {
      acceptedOutputModes: ["application/json"],
      returnImmediately: true,
      taskPushNotificationConfig: undefined,
    },
    metadata: undefined,
  });
  if (!("id" in pending))
    throw new Error("Cancellation workflow did not return an A2A Task");
  writeEvidence({
    type: "request",
    operation: "tasks.cancel",
    taskId: pending.id,
  });
  const canceled = await client.cancelTask({
    id: pending.id,
    tenant: "",
    metadata: undefined,
  });
  if (canceled.status?.state !== TaskState.TASK_STATE_CANCELED)
    throw new Error("A2A Task cancellation was not confirmed");
  writeEvidence({
    type: "response",
    operation: "tasks.cancel",
    taskId: canceled.id,
    state: canceled.status?.state,
  });
  process.stdout.write(`Task ${canceled.id} canceled\n`);
}

function findWorkflow(items: Record<string, unknown>[], name: string): string {
  const item = items.find(
    (workflow) =>
      typeof workflow.name === "string" &&
      workflow.name.toLowerCase().includes(name),
  );
  if (typeof item?.id !== "string")
    throw new Error(`No ${name} workflow found; set A2A_WORKFLOW_ID`);
  return item.id;
}

async function waitForTask(
  a2aClient: typeof client,
  initial: Task | Message,
): Promise<Task> {
  if (!("id" in initial)) throw new Error("Expected task result");
  let task = initial;
  const deadline = Date.now() + 60_000;
  while (
    task.status?.state === TaskState.TASK_STATE_WORKING &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    task = await a2aClient.getTask({
      id: task.id,
      tenant: "",
      historyLength: 10,
    });
  }
  return task;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeEvidence(record: Record<string, unknown>): void {
  process.stdout.write(`A2A_EVIDENCE ${JSON.stringify(record)}\n`);
}
