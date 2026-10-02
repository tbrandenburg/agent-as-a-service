const http = require("node:http");
const modules = process.env.NODE_RED_MODULES || "/usr/src/node-red/node_modules";
const express = require(`${modules}/express`);
const RED = require(`${modules}/node-red`);
const { join } = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const { createObserver } = require("./observer.js");
const { createHostLinkCaller } = require(process.env.LINK_CALL_MODULE || "./link-call.cjs");
const { runInput, runOutput } = require(process.env.RUN_SCHEMA_MODULE || "./run-output.cjs");

const [dir, port, runId] = process.argv.slice(2);
if (!dir || !Number.isSafeInteger(Number(port)) || !runId || !process.env.INTERNAL_TOKEN) throw new Error("Invalid worker host configuration");
process.env.NODE_RED_HOME ||= `${modules}/node-red`;
const settings = require(join(dir, "settings.js"));
Object.assign(settings, { userDir: dir, flowFile: join(dir, "flows.json"), settingsFile: join(dir, "settings.js"), uiHost: "127.0.0.1", uiPort: Number(port), httpAdminRoot: false, httpNodeRoot: "/" });
const app = express();
const server = http.createServer(app);
RED.init(server, settings);
const callback = async (body, path = "/node-observations") => {
  const response = await fetch(`${process.env.WORKER_CALLBACK_URL || "http://api:3095"}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Worker observation rejected (${response.status})`);
};
const observer = createObserver(RED.hooks, runId, callback);
let caller;
let invoked = false;
const timeout = Number(process.env.WORKER_TIMEOUT_MS || 450_000) - 500;
const authenticate = (request, response, next) => {
  const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(process.env.INTERNAL_TOKEN);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return response.status(401).json({ error: "Unauthorized" });
  next();
};
app.post("/activate", authenticate, (_request, response) => { observer.activate(); response.json({ active: true }); });
// The host listens only after flows:started; readiness never changes user flow JSON.
app.get("/ready", (_request, response) => response.json({ ready: true }));
app.post("/invoke", authenticate, express.json({ limit: "1mb" }), (request, response) => {
  const body = request.body;
  if (!body || body.runId !== runId || typeof body.entry !== "string" || !body.entry || !runInput.safeParse(body.input).success || Object.keys(body).some((key) => !["runId", "input", "entry"].includes(key))) return response.status(400).json({ error: "Invalid invocation" });
  if (invoked) return response.status(409).json({ error: "Worker already invoked" });
  invoked = true;
  // The host control state is authoritative, regardless of returned flow fields.
  const operation = caller.call(body.entry, { input: body.input, agentObservation: { runId } }, { timeout });
  response.status(202).json({ accepted: true });
  void operation.then((message) => {
    if (message.error || (message.agentExecution && message.agentExecution.status !== "completed")) throw new Error("Workflow node failed");
    return { status: "completed", output: runOutput.parse(message.payload) };
  }).catch((error) => {
    console.error("Workflow invocation failed", error instanceof Error ? error.name : "unknown");
    return { status: "failed" };
  }).then((result) => callback({ runId, eventId: `${runId}:link-call`, ...result }, "/finalize")).catch((error) => {
    console.error("Worker finalization failed", error instanceof Error ? error.message : "unknown");
    caller.close();
    RED.hooks.remove("onComplete.aaas-link-failure");
    process.exitCode = 1;
    server.close();
    void RED.stop().catch((failure) => { console.error("Worker shutdown failed", failure); process.exitCode = 1; });
  });
});
app.post("/drain", authenticate, async (_request, response) => {
  const result = await observer.drain();
  try { await callback(result, "/node-drain"); response.json({ drained: true }); }
  catch { response.status(503).json({ drained: false }); }
});
app.use(RED.httpNode);
const flowsStarted = new Promise((resolve) => RED.events.once("flows:started", resolve));
RED.start().then(() => Promise.race([flowsStarted, new Promise((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Worker flow startup timed out")), 25000);
  flowsStarted.then(() => clearTimeout(timer));
})])).then(() => {
  caller = createHostLinkCaller(RED);
  RED.hooks.add("onComplete.aaas-link-failure", ({ error }) => {
    if (error && invoked) caller.close(new Error("Workflow node failed"));
  });
  server.listen(Number(port), "127.0.0.1");
}).catch((error) => { console.error("Worker startup failed", error); process.exit(1); });
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  caller?.close();
  RED.hooks.remove("onComplete.aaas-link-failure");
  void RED.stop().then(() => server.close(() => { process.exitCode = 0; })).catch((error) => { console.error("Worker shutdown failed", error); process.exitCode = 1; });
});
