const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtemp, writeFile, rm, symlink, realpath, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");

const workers = new Map();
const max = 4;
const timeoutMs = Number(process.env.WORKER_TIMEOUT_MS || 450_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000) throw new Error("Invalid WORKER_TIMEOUT_MS");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function respond(response, code, body) { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
async function failed(id) {
  try {
    await fetch("http://api:3095/worker-failed", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: id }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error("Worker failure callback failed", error instanceof Error ? error.message : "unknown");
  }
}
async function stop(id) {
  const worker = workers.get(id);
  if (!worker) return;
  workers.delete(id);
  clearTimeout(worker.timeout);
  if (!worker.exited && worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGTERM");
  await Promise.race([worker.exit, sleep(5000)]);
  if (!worker.exited && worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
  await Promise.race([worker.exit, sleep(5000)]);
  await rm(worker.dir, { recursive: true, force: true });
}
async function start(job) {
  if (workers.has(job.runId) || workers.size >= max) throw new Error("Execution worker limit reached");
  const root = await realpath("/data/projects");
  const global = await realpath("/data/agent-work");
  const cwd = await realpath(job.cwd);
  if ((cwd !== global && !cwd.startsWith(`${root}/`)) || !(await stat(cwd)).isDirectory()) throw new Error("Working directory outside allowed roots");
  if (!job.tab || !Array.isArray(job.tab.nodes) || !Array.isArray(job.tab.configs) || typeof job.runId !== "string" || typeof job.path !== "string" || !/^\/(workflow\/agents|managed\/[a-f0-9-]{36}|agent\/writer-agent)$/.test(job.path)) throw new Error("Invalid worker snapshot");
  const dir = await mkdtemp(join(tmpdir(), "aaas-worker-"));
  try {
    await symlink("/data/node_modules", join(dir, "node_modules"));
    const tab = structuredClone(job.tab);
    const id = tab.id || randomUUID();
    for (const node of tab.nodes) node.z = id;
    if (tab.nodes.some((node) => ["inject", "cronplus", "trigger", "mqtt in", "tcp in", "websocket in"].includes(node.type))) throw new Error("Background trigger is not supported in worker");
    if (job.path === "/workflow/agents") {
      const entry = [...tab.nodes, ...tab.configs].find((node) => node.id === "workflow-entry");
      if (!entry) throw new Error("Core entry missing");
      entry.wires[0] = ["aaas-probe-exec"];
      tab.nodes.push(
        { id: "aaas-probe-exec", z: id, type: "exec", name: "Process-relative Exec", command: "pwd", addpay: false, append: "", useSpawn: "false", wires: [["aaas-probe-check"], [], []] },
        { id: "aaas-probe-check", z: id, type: "function", name: "Check process cwd", func: "if (msg.payload.trim() !== env.get('WORKER_CWD')) { node.error('Exec cwd differs from worker cwd'); return null; } msg.filename='aaas-cwd-proof-'+msg.runId+'.txt'; msg.payload=msg.text; return msg;", outputs: 1, wires: [["aaas-probe-file"]] },
        { id: "aaas-probe-file", z: id, type: "file", name: "Relative core File", filename: "filename", filenameType: "msg", appendNewline: false, overwriteFile: "true", createDir: false, encoding: "none", wires: [["aaas-probe-list"]] },
        { id: "aaas-probe-list", z: id, type: "cwd-list-example", name: "Process-relative JS listing", wires: [["aaas-probe-list-check"]] },
        { id: "aaas-probe-list-check", z: id, type: "function", name: "Check JS listing", func: "if (msg.cwdListing?.directory !== env.get('WORKER_CWD') || !msg.cwdListing?.files?.includes(msg.filename)) { node.error('Process-relative JavaScript listing missed File output'); return null; } msg.payload=msg.text; return msg;", outputs: 1, wires: [["writer-agent"]] },
      );
    }
    const flow = [{ id, type: "tab", label: tab.label }, ...tab.configs, ...tab.nodes,
      { id: "aaas-worker-ready-in", z: id, type: "http in", url: "/ready", method: "get", wires: [["aaas-worker-ready-body"]] },
      { id: "aaas-worker-ready-body", z: id, type: "function", func: "msg.payload={ready:true};return msg;", outputs: 1, wires: [["aaas-worker-ready-response"]] },
      { id: "aaas-worker-ready-response", z: id, type: "http response", wires: [] },
    ];
    // Store only one version of the definition; a worker never deploys editor changes.
    await writeFile(join(dir, "flows.json"), JSON.stringify(flow));
    await writeFile(join(dir, "settings.js"), `const base = require('/seed/settings.js'); module.exports = {...base, uiHost: '127.0.0.1', httpAdminRoot: false, fileWorkingDirectory: ${JSON.stringify(cwd)} };`);
    const port = await new Promise((resolve, reject) => {
      const socket = require("node:net").createServer();
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => { const chosen = socket.address().port; socket.close(() => resolve(chosen)); });
    });
    const child = spawn("node", ["/usr/src/node-red/node_modules/node-red/red.js", "--userDir", dir, "--settings", join(dir, "settings.js"), "--port", String(port)], { cwd, stdio: "inherit", env: { ...process.env, PWD: cwd, WORKER_CWD: cwd, WORKER_RUNTIME: "true" } });
    const worker = { child, dir, exited: false, exit: null, timeout: null };
    worker.exit = new Promise((resolve) => {
      const settled = () => { worker.exited = true; resolve(); if (workers.has(job.runId)) void failed(job.runId).finally(() => stop(job.runId)); };
      child.once("exit", settled);
      child.once("error", settled);
    });
    worker.timeout = setTimeout(() => { void failed(job.runId).finally(() => stop(job.runId)); }, timeoutMs);
    workers.set(job.runId, worker);
    for (let attempt = 0; attempt < 150; attempt++) {
      if (worker.exited) throw new Error("Worker exited before ready");
      try {
        const ready = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(500) });
        if (ready.ok) break;
      } catch { /* worker still starting */ }
      if (attempt === 149) throw new Error("Worker readiness timeout");
      await sleep(200);
    }
    const response = await fetch(`http://127.0.0.1:${port}${job.path}`, { method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ runId: job.runId, text: job.text, sessionID: job.sessionID }), signal: AbortSignal.timeout(10_000) });
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
  } catch (error) { console.error("Worker failed", error instanceof Error ? error.message : "unknown"); respond(response, 503, { error: "Worker unavailable" }); }
});
if (require.main === module) server.listen(1881, "0.0.0.0");
async function read(request) {
  const parts = [];
  for await (const part of request) { parts.push(part); if (Buffer.concat(parts).length > 1_000_000) throw new Error("Too large"); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
if (require.main === module) process.on("SIGTERM", () => { for (const id of workers.keys()) void stop(id); });
module.exports = { stop, workers, server };
