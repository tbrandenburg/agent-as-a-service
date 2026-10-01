import express from "express";
import { timingSafeEqual } from "node:crypto";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend, WorkerCapacityError } from "./backend.js";
import { JsonStore } from "./registry.js";
import { Projects } from "./projects.js";

const token = process.env.API_TOKEN ?? "dev-token";
const internalToken = process.env.INTERNAL_TOKEN;
if (!internalToken || internalToken === token)
  throw new Error("A distinct INTERNAL_TOKEN is required");
const workerUrl = process.env.WORKER_URL ?? "http://node-red:1881";
const maxWorkers = Number(process.env.MAX_WORKERS ?? "4");
if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32)
  throw new Error("Invalid MAX_WORKERS");
const workerCall = async (path: string, body: unknown) => {
  const response = await fetch(`${workerUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${internalToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw response.status === 429
      ? new WorkerCapacityError("Worker capacity wait timed out")
      : new Error(`Worker ${path} failed (${response.status})`);
};
const backend = new AgentsBackend(
  async (payload) => workerCall("/start", payload),
  new JsonStore(
    process.env.WORKFLOW_REGISTRY ?? "/workspace-data/workflows.json",
  ),
  new Projects("/data/projects", "/data/agent-work"),
  async (id) => workerCall("/stop", { runId: id }),
  maxWorkers,
);
const internal = express();
internal.use(express.json({ limit: "1mb" }));
internal.use((request, response, next) => {
  const supplied = Buffer.from(
    request.headers.authorization?.replace(/^Bearer /, "") ?? "",
  );
  const expected = Buffer.from(internalToken);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});
internal.post("/observations", (request, response) => {
  const result = backend.observe(request.body);
  response.status(result.status).json(result.body);
});
internal.post("/node-observations", (request, response) => {
  const result = backend.observeNodes(request.body);
  response.status(result.status).json(result.body);
});
internal.post("/node-drain", (request, response) => {
  const result = backend.drainNodes(request.body);
  response.status(result.status).json(result.body);
});
internal.get("/inventory", (_request, response) => {
  response.json(Object.fromEntries(backend.inventory));
});
internal.post("/finalize", (request, response) => {
  const result = backend.finalize(request.body);
  response.status(result.status).json(result.body);
});
internal.post("/worker-failed", (request, response) => {
  backend.workerFailed(request.body.runId);
  response.json({ acknowledged: true });
});
const privateServer = internal.listen(3095, "0.0.0.0");
await backend.initialize();
const publicServer = createApp({
  token,
  implementation: backend.implementation(),
}).listen(3094, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    publicServer.close(() => privateServer.close(() => process.exit(0)));
  });
