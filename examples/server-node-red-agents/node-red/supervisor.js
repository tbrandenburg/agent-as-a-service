const http = require("node:http");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { mkdtemp, writeFile, rm, symlink, realpath, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const workers = new Map();
const starting = new Set();
const waiting = new Set();
const max = Number(process.env.MAX_WORKERS ?? "4");
if (!Number.isSafeInteger(max) || max < 1 || max > 32) throw new Error("Invalid MAX_WORKERS");
const capacityWaitMs = 20_000;
const released = new Set();
function notifyRelease() { for (const wake of released) wake(); released.clear(); }
async function waitForSlot(id) {
  const deadline = Date.now() + capacityWaitMs;
  while (workers.size + starting.size >= max) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Worker capacity wait timed out");
    await new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); released.delete(wake); resolve(); };
      const timer = setTimeout(wake, remaining);
      released.add(wake);
    });
  }
  // Reserve synchronously before another awakened waiter can inspect capacity.
  starting.add(id);
}
const timeoutMs = Number(process.env.WORKER_TIMEOUT_MS || 450_000);
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
    const response = await fetch("http://api:3095/worker-failed", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: id }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Worker failure rejected (${response.status})`);
  } catch (error) {
    console.error("Worker failure callback failed", error instanceof Error ? error.message : "unknown");
  }
}
async function stop(id) {
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
  await worker.exit;
  await rm(worker.dir, { recursive: true, force: true });
  workers.delete(id);
  notifyRelease();
}
async function start(job, launchWorker = launch) {
  const id = job.runId;
  if (typeof id !== "string" || !id || workers.has(id) || starting.has(id) || waiting.has(id)) throw new Error("Duplicate or invalid execution worker");
  waiting.add(id);
  try {
    await waitForSlot(id);
    await launchWorker(job);
  } finally {
    waiting.delete(id);
    if (starting.delete(id)) notifyRelease();
  }
}
async function launch(job) {
  const root = await realpath("/data/projects");
  const global = await realpath("/data/agent-work");
  const cwd = await realpath(job.cwd);
  if ((cwd !== global && !cwd.startsWith(`${root}/`)) || !(await stat(cwd)).isDirectory()) throw new Error("Working directory outside allowed roots");
  if (!Array.isArray(job.flows) || !job.flows.length || typeof job.runId !== "string" || (job.target ? typeof job.target !== "string" : job.path !== "/agent/writer-agent")) throw new Error("Invalid worker snapshot");
  const dir = await mkdtemp(join(tmpdir(), "aaas-worker-"));
  try {
    await symlink("/data/node_modules", join(dir, "node_modules"));
    // Store only one version of the definition; a worker never deploys editor changes.
    await writeSnapshot(dir, job.flows);
    await writeFile(join(dir, "settings.js"), `const base = require('/seed/settings.js'); module.exports = {...base, uiHost: '127.0.0.1', httpAdminRoot: false, fileWorkingDirectory: ${JSON.stringify(cwd)} };`);
    const port = await new Promise((resolve, reject) => {
      const socket = require("node:net").createServer();
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => { const chosen = socket.address().port; socket.close(() => resolve(chosen)); });
    });
    const child = spawn("node", ["/seed/worker-host.js", dir, String(port), job.runId], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, PWD: cwd, WORKER_CWD: cwd, WORKER_RUNTIME: "true" } });
    forwardWorkerOutput(child.stdout, process.stdout, job.runId);
    forwardWorkerOutput(child.stderr, process.stderr, job.runId);
    const worker = { child, dir, port, group: child.pid, exited: false, exit: null, timeout: null };
    worker.exit = new Promise((resolve) => {
      const settled = () => { worker.exited = true; resolve(); if (workers.has(job.runId)) void failed(job.runId).finally(() => stop(job.runId)); };
      child.once("exit", settled);
      child.once("error", settled);
    });
    worker.timeout = setTimeout(() => { void failed(job.runId).finally(() => stop(job.runId)); }, timeoutMs);
    workers.set(job.runId, worker);
    starting.delete(job.runId);
    for (let attempt = 0; attempt < 150; attempt++) {
      if (worker.exited) throw new Error("Worker exited before ready");
      try {
        const ready = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(500) });
        if (ready.ok) break;
      } catch { /* worker still starting */ }
      if (attempt === 149) throw new Error("Worker readiness timeout");
      await sleep(200);
    }
    const activated = await fetch(`http://127.0.0.1:${port}/activate`, { method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(5000) });
    if (!activated.ok) throw new Error("Worker observer could not activate");
    const response = await fetch(`http://127.0.0.1:${port}${job.target ? "/invoke" : job.path}`, { method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(job.target ? { runId: job.runId, input: job.input, target: job.target } : { runId: job.runId, text: job.text, sessionID: job.sessionID }), signal: AbortSignal.timeout(10_000) });
    if (response.status !== 202) throw new Error("Worker dispatch rejected");
  } catch (error) {
    await stop(job.runId);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${process.env.INTERNAL_TOKEN}`) return respond(response, 401, { error: "Unauthorized" });
  try {
    if (request.method === "GET" && request.url === "/ready") return respond(response, 200, { ready: true });
    if (request.method === "POST" && request.url === "/stop") {
      const body = await read(request);
      await stop(body.runId);
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
if (require.main === module) server.listen(1881, "0.0.0.0");
async function read(request) {
  const parts = [];
  for await (const part of request) { parts.push(part); if (Buffer.concat(parts).length > 1_000_000) throw new Error("Too large"); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
if (require.main === module) process.on("SIGTERM", () => { for (const id of workers.keys()) void stop(id); });
async function writeSnapshot(dir, flows) { await writeFile(join(dir, "flows.json"), JSON.stringify(flows)); }
module.exports = { stop, start, workers, server, forwardWorkerOutput, writeSnapshot };
