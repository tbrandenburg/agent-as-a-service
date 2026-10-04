const http = require("node:http");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { mkdtemp, writeFile, rm, symlink, realpath, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { resolveConfig, resolveNodeRedModules, packageDir } = require("./config.cjs");

const config = resolveConfig();
const nodeRedModules = resolveNodeRedModules();

const workers = new Map();
const starting = new Set();
const waiting = new Set();
const pending = new Map();
// Permanent IDs cannot be reused during this supervisor lifetime. Pending
// promises/reservations are transient; tombstones carry no worker resources.
const stopped = new Set();
function checkStopped(id) { if (stopped.has(id)) throw new Error("Execution worker stopped"); }
const max = config.maxWorkers;
if (!Number.isSafeInteger(max) || max < 1 || max > 32) throw new Error("Invalid MAX_WORKERS");
const capacityWaitMs = 20_000;
const internalRequestLimit = 3 * 1024 * 1024;
const released = new Set();
function notifyRelease() { for (const wake of released) wake(); released.clear(); }
async function waitForSlot(id) {
  const deadline = Date.now() + capacityWaitMs;
  while (workers.size + starting.size >= max) {
    checkStopped(id);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Worker capacity wait timed out");
    await new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); released.delete(wake); resolve(); };
      const timer = setTimeout(wake, remaining);
      released.add(wake);
    });
  }
  checkStopped(id);
  // Reserve synchronously before another awakened waiter can inspect capacity.
  starting.add(id);
}
const timeoutMs = config.workerTimeoutMs;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000) throw new Error("Invalid WORKER_TIMEOUT_MS");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function forwardWorkerOutput(input, output, id) {
  return createInterface({ input, crlfDelay: Infinity }).on("line", (line) => {
    if (!output.write(`[worker runId=${id}] ${line}\n`)) {
      input.pause();
      output.once("drain", () => input.resume());
    }
  });
}
function respond(response, code, body) { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
async function failed(id) {
  try {
    const response = await fetch(`${config.callbackUrl}/worker-failed`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: workers.get(id)?.runId, attemptId: id }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Worker failure rejected (${response.status})`);
  } catch (error) {
    console.error("Worker failure callback failed", error instanceof Error ? error.message : "unknown");
  }
}
async function stop(id) {
  if (typeof id !== "string" || !id) throw new Error("Invalid execution worker");
  stopped.add(id);
  notifyRelease();
  const launching = pending.get(id);
  if (launching) await launching;
  await stopWorker(id);
}
async function stopWorker(id) {
  const worker = workers.get(id);
  if (!worker) return;
  if (worker.stopping) return worker.stopping;
  worker.stopping = (async () => {
    if (!worker.exited && worker.port) {
      try {
        const response = await fetch(`http://127.0.0.1:${worker.port}/drain`, { method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) await failed(id);
      } catch { await failed(id); }
    }
    await cleanup(id, worker);
  })().catch((error) => {
    worker.stopping = null;
    throw error;
  });
  return worker.stopping;
}
async function cleanup(id, worker) {
  clearTimeout(worker.timeout);
  const signal = (name) => {
    if (worker.group) {
      try { process.kill(-worker.group, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
    } else if (!worker.exited && worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill(name);
  };
  signal("SIGTERM");
  await Promise.race([worker.exit, sleep(5000)]);
  signal("SIGKILL");
  await Promise.race([worker.exit, sleep(5000).then(() => { if (!worker.exited) throw new Error("Worker termination unconfirmed"); })]);
  await rm(worker.dir, { recursive: true, force: true });
  workers.delete(id);
  console.log(JSON.stringify({ type: "attempt.stopped", runId: worker.runId, attemptId: id }));
  notifyRelease();
}
async function start(job, launchWorker = launch) {
  const id = job.attemptId;
  if (typeof id !== "string" || !id || workers.has(id) || starting.has(id) || waiting.has(id)) throw new Error("Duplicate or invalid execution worker");
  checkStopped(id);
  let settle;
  pending.set(id, new Promise((resolve) => { settle = resolve; }));
  waiting.add(id);
  try {
    await waitForSlot(id);
    checkStopped(id);
    await launchWorker(job);
    checkStopped(id);
  } finally {
    waiting.delete(id);
    if (starting.delete(id)) notifyRelease();
    pending.delete(id);
    settle();
  }
}
async function launch(job) {
  const root = await realpath(config.projectsRoot);
  const global = await realpath(config.globalWorkRoot);
  const cwd = await realpath(job.cwd);
  if ((cwd !== global && !cwd.startsWith(`${root}/`)) || !(await stat(cwd)).isDirectory()) throw new Error("Working directory outside allowed roots");
  if (!Array.isArray(job.flows) || !job.flows.length || typeof job.runId !== "string" || typeof job.attemptId !== "string" || typeof job.entry !== "string" || !job.entry || Object.keys(job).some((key) => !["runId", "attemptId", "sequence", "resume", "input", "entry", "flows", "cwd"].includes(key))) throw new Error("Invalid worker snapshot");
  const id = job.attemptId;
  const dir = await mkdtemp(join(tmpdir(), "aaas-worker-"));
  try {
    await symlink(config.paletteModules, join(dir, "node_modules"));
    // Store only one version of the definition; a worker never deploys editor changes.
    await writeSnapshot(dir, job.flows);
    await writeFile(join(dir, "settings.js"), `const base = require(${JSON.stringify(join(packageDir, "lib/settings.cjs"))}); module.exports = {...base, uiHost: '127.0.0.1', httpAdminRoot: false, fileWorkingDirectory: ${JSON.stringify(cwd)} };`);
    const port = await new Promise((resolve, reject) => {
      const socket = require("node:net").createServer();
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => { const chosen = socket.address().port; socket.close(() => resolve(chosen)); });
    });
    checkStopped(id);
    const child = spawn(process.execPath, [join(packageDir, "lib/worker-host.cjs"), dir, String(port), job.runId, id, String(job.sequence ?? 0)], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, NODE_RED_MODULES: nodeRedModules, PWD: cwd, WORKER_CWD: cwd, WORKER_RUNTIME: "true" } });
    forwardWorkerOutput(child.stdout, process.stdout, job.runId);
    forwardWorkerOutput(child.stderr, process.stderr, job.runId);
    const worker = { child, dir, port, runId: job.runId, group: child.pid, exited: false, exit: null, timeout: null };
    worker.exit = new Promise((resolve) => {
      const settled = () => { worker.exited = true; resolve(); if (workers.has(id) && !stopped.has(id)) void failed(id).finally(() => stop(id)); };
      child.once("exit", settled);
      child.once("error", settled);
    });
    worker.timeout = setTimeout(() => { void failed(id).finally(() => stop(id)); }, timeoutMs);
    workers.set(id, worker);
    console.log(JSON.stringify({ type: "attempt.started", runId: job.runId, attemptId: id }));
    starting.delete(id);
    for (let attempt = 0; attempt < 150; attempt++) {
      checkStopped(id);
      if (worker.exited) throw new Error("Worker exited before ready");
      try {
        const ready = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(500) });
        if (ready.ok) break;
      } catch { /* worker still starting */ }
      if (attempt === 149) throw new Error("Worker readiness timeout");
      await sleep(200);
    }
    checkStopped(id);
    const activated = await fetch(`http://127.0.0.1:${port}/activate`, { method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(5000) });
    if (!activated.ok) throw new Error("Worker observer could not activate");
    checkStopped(id);
    const response = await fetch(`http://127.0.0.1:${port}/invoke`, { method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ runId: job.runId, input: job.input, entry: job.entry, ...(job.resume ? { resume: job.resume } : {}) }), signal: AbortSignal.timeout(10_000) });
    if (response.status !== 202) throw new Error("Worker dispatch rejected");
  } catch (error) {
    stopped.add(id);
    await stopWorker(id);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${process.env.INTERNAL_TOKEN}`) return respond(response, 401, { error: "Unauthorized" });
  try {
    if (request.method === "GET" && request.url === "/ready") return respond(response, 200, { ready: true });
    if (request.method === "GET" && request.url === "/capacity") return respond(response, 200, { occupied: workers.size + starting.size, workers: [...workers].map(([attemptId, worker]) => ({ attemptId, runId: worker.runId })), starting: [...starting], waiting: [...waiting] });
    if (request.method === "POST" && request.url === "/stop") {
      const body = await read(request);
      await stop(body.attemptId);
      return respond(response, 200, { stopped: true });
    }
    if (request.method === "POST" && request.url === "/start") {
      const body = await read(request);
      await start(body);
      return respond(response, 202, { accepted: true });
    }
    respond(response, 404, { error: "Not found" });
  } catch (error) { console.error("Worker failed", error instanceof Error ? error.message : "unknown"); respond(response, error instanceof Error && error.message === "Worker capacity wait timed out" ? 429 : 503, { error: "Worker unavailable" }); }
});
function listen() { server.listen(Number(process.env.PORT || 1881), process.env.HOST || "0.0.0.0"); }
if (require.main === module) listen();
async function read(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > internalRequestLimit) throw new Error("Too large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts, size).toString("utf8"));
}
let shutdown;
function close(signal) {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    for (const id of new Set([...workers.keys(), ...pending.keys()])) {
      try { await stop(id); }
      catch (error) { console.error(`Worker shutdown failed (${id})`, error instanceof Error ? error.message : "unknown"); }
    }
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(resolve);
    });
    if (signal) process.exitCode = 0;
  })();
  return shutdown;
}
function installSignalHandlers() {
  process.on("SIGTERM", () => { void close("SIGTERM"); });
  process.on("SIGINT", () => { void close("SIGINT"); });
}
if (require.main === module) installSignalHandlers();
async function writeSnapshot(dir, flows) { await writeFile(join(dir, "flows.json"), JSON.stringify(flows)); }
module.exports = { stop, start, workers, pending, starting, waiting, server, listen, close, installSignalHandlers, forwardWorkerOutput, writeSnapshot, read, internalRequestLimit };
