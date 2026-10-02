import { createClient, startRun } from "../../client/src/index.js";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !/^https?:\/\//.test(base) || !token?.trim())
  throw new Error("DEMO_BASE_URL and API_TOKEN are required");
const api = createClient(base, token);
const title = (number: number, label: string) =>
  console.log(`\n${number}. ${label}`);
const status = (actual: number, wanted: number, label: string) => {
  if (actual !== wanted)
    throw new Error(`${label}: expected HTTP ${wanted}, got ${actual}`);
  console.log(`  ${label}: HTTP ${actual}`);
};
const reject = (
  actual: { status: number; body: unknown },
  wanted: number,
  code: string,
  label: string,
) => {
  status(actual.status, wanted, label);
  if (
    typeof actual.body !== "object" ||
    actual.body === null ||
    !("error" in actual.body) ||
    typeof actual.body.error !== "object" ||
    actual.body.error === null ||
    !("code" in actual.body.error) ||
    actual.body.error.code !== code
  )
    throw new Error(`${label}: expected error code ${code}`);
};

title(1, "Public health and OpenAPI discovery");
status((await fetch(`${base}/api/v1/health`)).status, 200, "health");
const openapi = await fetch(`${base}/api/v1/openapi.json`);
status(openapi.status, 200, "OpenAPI");
const document = (await openapi.json()) as { paths?: Record<string, unknown> };
if (!document.paths?.["/api/v1/runs"] || !document.paths["/api/v1/workflows"])
  throw new Error("OpenAPI workflow/run paths missing");

title(2, "Authenticated workflow listing and lookup");
const list = await api.workflows.listWorkflows({ query: { limit: 25 } });
status(list.status, 200, "list workflows");
if (
  list.status !== 200 ||
  list.body.items.length !== 1 ||
  list.body.items[0]?.id !== "node-red-demo"
)
  throw new Error("Expected exactly one fixed workflow");
const workflow = await api.workflows.getWorkflow({
  params: { workflowId: "node-red-demo" },
});
status(workflow.status, 200, "get workflow");
if (
  workflow.status !== 200 ||
  workflow.body.readOnly !== true ||
  workflow.body.engine !== "node-red" ||
  workflow.body.specificationVersion !== "5.x"
)
  throw new Error(
    "Workflow metadata does not identify the read-only Node-RED flow",
  );

title(3, "Meaningful workflow validation");
const definition = {
  engine: "node-red",
  specificationVersion: "5.x",
  specification: { endpoint: "/workflow/demo" },
};
const valid = await api.workflows.validateWorkflow({ body: definition });
status(valid.status, 200, "valid definition");
if (valid.status !== 200 || !valid.body.valid || valid.body.errors.length)
  throw new Error("Fixed workflow definition should validate");
const invalid = await api.workflows.validateWorkflow({
  body: { ...definition, specification: { endpoint: "/wrong" } },
});
status(invalid.status, 200, "invalid definition");
if (invalid.status !== 200 || invalid.body.valid || !invalid.body.errors.length)
  throw new Error("Unknown endpoint must fail validation");

title(4, "Accept run, read immediately, and verify real flow output");
const accepted = await startRun(api, {
  target: { kind: "workflow", id: "node-red-demo" },
  input: { text: "hello" },
});
status(accepted.status, 202, "start run");
if (accepted.status !== 202 || accepted.body.run.status !== "queued")
  throw new Error("Expected queued run in 202 response");
const runId = accepted.body.run.id;
const immediate = await api.runs.getRun({ params: { runId } });
status(immediate.status, 200, "immediately readable run");
if (immediate.status !== 200 || immediate.body.run.id !== runId)
  throw new Error("Accepted run not immediately readable");
let result = immediate.body.run;
const deadline = Date.now() + 30_000;
while (
  result.status !== "completed" &&
  result.status !== "failed" &&
  Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const current = await api.runs.getRun({ params: { runId } });
  status(current.status, 200, "poll run");
  if (current.status !== 200) throw new Error("Run disappeared");
  result = current.body.run;
}
if (
  result.status !== "completed" ||
  result.output !== "Node-RED processed: hello"
)
  throw new Error(
    `Real flow output missing: ${result.status} ${result.error?.code ?? "timeout"}`,
  );
console.log(`  run ${runId}: ${result.output}`);

title(5, "Ordered, replayable lifecycle events");
const events = await api.runs.listEvents({
  params: { runId },
  query: { after: 0, limit: 100 },
});
status(events.status, 200, "list events");
if (
  events.status !== 200 ||
  events.body.length !== 3 ||
  events.body.some(
    (event, index) =>
      event.sequence !== index + 1 ||
      event.runId !== runId ||
      event.type !== "run.updated",
  ) ||
  events.body.map((event) => event.data?.status).join(",") !==
    "queued,running,completed"
)
  throw new Error("Expected ordered queued → running → completed events");
const replay = await api.runs.listEvents({
  params: { runId },
  query: { after: 1, limit: 1 },
});
status(replay.status, 200, "cursor replay");
if (
  replay.status !== 200 ||
  replay.body.length !== 1 ||
  replay.body[0]?.sequence !== 2
)
  throw new Error("Event cursor failed");

title(6, "Expected rejections and intentional 501 fallbacks");
const missingToken = await fetch(`${base}/api/v1/workflows`);
reject(
  { status: missingToken.status, body: await missingToken.json() },
  401,
  "unauthorized",
  "missing token",
);
const wrongToken = await fetch(`${base}/api/v1/workflows`, {
  headers: { authorization: "Bearer wrong-token" },
});
reject(
  { status: wrongToken.status, body: await wrongToken.json() },
  401,
  "unauthorized",
  "wrong token",
);
reject(
  await api.workflows.getWorkflow({ params: { workflowId: "unknown" } }),
  404,
  "not_found",
  "unknown workflow",
);
reject(
  await api.runs.getRun({ params: { runId: "unknown" } }),
  404,
  "not_found",
  "unknown run",
);
reject(
  await startRun(api, {
    target: { kind: "workflow", id: "unknown" },
    input: { text: "hello" },
  }),
  404,
  "not_found",
  "unknown run target",
);
reject(
  await startRun(api, {
    target: { kind: "workflow", id: "node-red-demo" },
    input: { text: "" },
  }),
  400,
  "invalid_input",
  "invalid input",
);
reject(
  await api.workflows.createWorkflow({ body: definition }),
  501,
  "not_implemented",
  "workflow create",
);
reject(
  await api.workflows.updateWorkflow({
    params: { workflowId: "node-red-demo" },
    headers: {},
    body: definition,
  }),
  501,
  "not_implemented",
  "workflow update",
);
reject(
  await api.workflows.deleteWorkflow({
    params: { workflowId: "node-red-demo" },
  }),
  501,
  "not_implemented",
  "workflow delete",
);
reject(
  await api.runs.cancelRun({ params: { runId }, body: {} }),
  501,
  "not_implemented",
  "run cancellation",
);

console.log(
  "\nDemo complete: private Node-RED execution verified through the unchanged AaaS contract.\n",
);
