const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { resolveConfig, resolveNodeRedModules, createNodeRedRequire, callbackDestination } = require("../lib/config.cjs");

test("configuration keeps callback, roots and capacity deployment-configurable", () => {
  const root = mkdtempSync(join(tmpdir(), "aaas-host-config-"));
  const prior = { ...process.env };
  try {
    process.env.INTERNAL_TOKEN = "test-token";
    process.env.WORKER_CALLBACK_URL = "http://callback.internal:3095/";
    process.env.PROJECTS_ROOT = join(root, "projects");
    process.env.GLOBAL_WORK_ROOT = join(root, "global");
    process.env.PALETTE_NODE_MODULES = join(root, "modules");
    process.env.MAX_WORKERS = "3";
    require("node:fs").mkdirSync(process.env.PROJECTS_ROOT);
    require("node:fs").mkdirSync(process.env.GLOBAL_WORK_ROOT);
    require("node:fs").mkdirSync(process.env.PALETTE_NODE_MODULES);
    const config = resolveConfig();
    assert.equal(config.callbackUrl, "http://callback.internal:3095");
    assert.equal(config.projectsRoot, process.env.PROJECTS_ROOT);
    assert.equal(config.globalWorkRoot, process.env.GLOBAL_WORK_ROOT);
    assert.equal(config.maxWorkers, 3);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("callback base rejects URL components that can redirect callback routes", () => {
  const root = mkdtempSync(join(tmpdir(), "aaas-host-config-invalid-url-"));
  const prior = { ...process.env };
  try {
    for (const value of ["http://host/base", "http://host/?x=1", "http://host/#fragment", "http://user@host/", "file:///tmp"]) {
      process.env.INTERNAL_TOKEN = "test-token";
      process.env.WORKER_CALLBACK_URL = value;
      process.env.PROJECTS_ROOT = root;
      process.env.GLOBAL_WORK_ROOT = root;
      process.env.PALETTE_NODE_MODULES = root;
      assert.throws(resolveConfig, /WORKER_CALLBACK_URL must be an HTTP\(S\) base URL/);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("callback destinations use one slash-normalized base for every existing route", async () => {
  const http = require("node:http");
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const prior = process.env.WORKER_CALLBACK_URL;
  const token = process.env.INTERNAL_TOKEN;
  try {
    process.env.WORKER_CALLBACK_URL = `http://127.0.0.1:${server.address().port}////`;
    process.env.INTERNAL_TOKEN = "callback-test-token";
    const routes = ["/observations", "/node-observations", "/node-drain", "/finalize", "/interaction-suspend", "/interaction-admitted", "/worker-failed"];
    for (const path of routes) {
      const response = await fetch(callbackDestination(path), { method: "POST", body: JSON.stringify({ route: path }), headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
    }
    const settingsPath = require.resolve("../lib/settings.cjs");
    delete require.cache[settingsPath];
    const settings = require(settingsPath);
    await settings.nodeRedAgentsLifecycleObserver({ type: "test", status: "completed" });
    assert.deepEqual(received.map(({ path }) => path), [...routes, "/observations"]);
    assert.equal(received.some(({ path }) => path.startsWith("//")), false);
    assert.deepEqual(JSON.parse(received.at(-1).body), { type: "test", status: "completed" });
  } finally {
    if (prior === undefined) delete process.env.WORKER_CALLBACK_URL;
    else process.env.WORKER_CALLBACK_URL = prior;
    if (token === undefined) delete process.env.INTERNAL_TOKEN;
    else process.env.INTERNAL_TOKEN = token;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CLI rejects missing internal authentication configuration clearly", () => {
  const result = spawnSync(process.execPath, [require.resolve("../bin/aaas-node-red-host.cjs")], {
    encoding: "utf8",
    env: { ...process.env, INTERNAL_TOKEN: "", WORKER_CALLBACK_URL: "http://localhost:3095" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INTERNAL_TOKEN is required/);
});

test("CLI requires one configured callback base URL", () => {
  const result = spawnSync(process.execPath, [require.resolve("../bin/aaas-node-red-host.cjs")], {
    encoding: "utf8",
    env: { ...process.env, INTERNAL_TOKEN: "test-token", WORKER_CALLBACK_URL: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKER_CALLBACK_URL is required/);
});

test("stock image module directory is used when explicitly configured", () => {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(require('./lib/config.cjs').resolveNodeRedModules())"], {
    cwd: require("node:path").resolve(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, NODE_RED_MODULES: "/usr/src/node-red/node_modules" },
  });
  if (result.status === 0) assert.equal(result.stdout, "/usr/src/node-red/node_modules");
  else assert.match(result.stderr, /Configured NODE_RED_MODULES does not contain a loadable Node-RED runtime with Express/);
  assert.equal(typeof resolveNodeRedModules, "function");
});

test("a local Node-RED runtime is preferred to the stock image fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "aaas-host-runtime-"));
  const modules = join(root, "node_modules");
  const fs = require("node:fs");
  try {
    fs.mkdirSync(join(modules, "node-red"), { recursive: true });
    fs.mkdirSync(join(modules, "express"), { recursive: true });
    fs.writeFileSync(join(modules, "node-red", "package.json"), JSON.stringify({ name: "node-red", main: "index.cjs" }));
    fs.writeFileSync(join(modules, "node-red", "index.cjs"), "module.exports = {};\n");
    fs.writeFileSync(join(modules, "express", "package.json"), JSON.stringify({ name: "express", main: "index.cjs" }));
    fs.writeFileSync(join(modules, "express", "index.cjs"), "module.exports = {};\n");
    const configPath = require.resolve("../lib/config.cjs");
    const result = spawnSync(process.execPath, ["-e", `process.stdout.write(require(${JSON.stringify(configPath)}).resolveNodeRedModules())`], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_RED_MODULES: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, modules);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Express resolves and loads from Node-RED's nested dependency tree", () => {
  const root = mkdtempSync(join(tmpdir(), "aaas-host-nested-node-red-"));
  const modules = join(root, "node_modules");
  const fs = require("node:fs");
  try {
    const nodeRedDir = join(modules, "node-red");
    const expressDir = join(nodeRedDir, "node_modules", "express");
    fs.mkdirSync(join(expressDir), { recursive: true });
    fs.mkdirSync(join(nodeRedDir, "node_modules"), { recursive: true });
    fs.writeFileSync(join(nodeRedDir, "package.json"), JSON.stringify({ name: "node-red", main: "index.cjs" }));
    fs.writeFileSync(join(nodeRedDir, "index.cjs"), "module.exports = {};\n");
    fs.writeFileSync(join(expressDir, "package.json"), JSON.stringify({ name: "express", main: "index.cjs" }));
    fs.writeFileSync(join(expressDir, "index.cjs"), "module.exports = { selected: 'nested-node-red-express' };\n");
    fs.mkdirSync(join(modules, "express"), { recursive: true });
    fs.writeFileSync(join(modules, "express", "package.json"), JSON.stringify({ name: "express", main: "missing.cjs" }));
    const priorModules = process.env.NODE_RED_MODULES;
    process.env.NODE_RED_MODULES = modules;
    try {
      const nodeRedRequire = createNodeRedRequire(modules);
      assert.equal(nodeRedRequire("express").selected, "nested-node-red-express");
      assert.equal(nodeRedRequire.resolve("express"), join(expressDir, "index.cjs"));
      assert.equal(resolveNodeRedModules(), resolve(modules));
    } finally {
      if (priorModules === undefined) delete process.env.NODE_RED_MODULES;
      else process.env.NODE_RED_MODULES = priorModules;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI keeps the launcher runtime across worker cwd changes and drains workers on SIGTERM", async (context) => {
  const fs = require("node:fs");
  const http = require("node:http");
  const { spawn } = require("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "aaas-host-cli-runtime-"));
  const launcher = join(root, "launcher");
  const project = join(root, "projects", "project");
  const global = join(root, "global");
  const temp = join(root, "temp");
  const marker = `aaas-review-descendant-${process.pid}`;
  const runtime = process.env.NODE_RED_TEST_MODULES;
  for (const dir of [launcher, project, global, temp]) fs.mkdirSync(dir, { recursive: true });
  if (!runtime || !fs.existsSync(join(runtime, "node-red/package.json")) || !fs.existsSync(join(runtime, "express/package.json"))) {
    rmSync(root, { recursive: true, force: true });
    context.skip("Set NODE_RED_TEST_MODULES to a real Node-RED runtime node_modules directory");
    return;
  }
  fs.symlinkSync(runtime, join(launcher, "node_modules"), "dir");
  const discovered = spawnSync(process.execPath, ["-e", `process.stdout.write(require(${JSON.stringify(require.resolve("../lib/config.cjs"))}).resolveNodeRedModules())`], { cwd: launcher, encoding: "utf8", env: { ...process.env, NODE_RED_MODULES: "" } });
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.equal(discovered.stdout, fs.realpathSync(runtime));
  const relative = spawnSync(process.execPath, ["-e", `process.stdout.write(require(${JSON.stringify(require.resolve("../lib/config.cjs"))}).resolveNodeRedModules())`], { cwd: launcher, encoding: "utf8", env: { ...process.env, NODE_RED_MODULES: "node_modules" } });
  assert.equal(relative.status, 0, relative.stderr);
  assert.equal(relative.stdout, fs.realpathSync(runtime));
  const callback = http.createServer((_request, response) => { response.writeHead(200); response.end("{}"); });
  await new Promise((resolve) => callback.listen(0, "127.0.0.1", resolve));
  const port = callback.address().port;
  const hostPort = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const token = "integration-token";
  const child = spawn(process.execPath, [require.resolve("../bin/aaas-node-red-host.cjs")], {
    cwd: launcher,
    env: { ...process.env, INTERNAL_TOKEN: token, WORKER_CALLBACK_URL: `http://127.0.0.1:${port}`, PROJECTS_ROOT: join(root, "projects"), GLOBAL_WORK_ROOT: global, PALETTE_NODE_MODULES: runtime, NODE_RED_MODULES: "", HOST: "127.0.0.1", PORT: String(hostPort), TMPDIR: temp, WORKER_TIMEOUT_MS: "30000" },
    stdio: "ignore",
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const workerDir = () => fs.readdirSync(temp).map((name) => join(temp, name)).find((dir) => fs.existsSync(join(dir, "settings.js")));
  const request = async (path, body) => fetch(`http://127.0.0.1:${hostPort}${path}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 30000 : 1000) });
  const waitFor = async (predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error("Timed out waiting for CLI host integration state");
  };
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error("CLI host exited before readiness");
      return request("/ready").then((response) => response.ok).catch(() => false);
    });
    const activeFlows = [
      { id: "tab", type: "tab" },
      { id: "entry", z: "tab", type: "link in", wires: [["hold"]] },
      { id: "hold", z: "tab", type: "exec", command: `${process.execPath} -e 'process.title="${marker}"; setInterval(()=>{},1000)'`, addpay: false, append: "", useSpawn: "true", timer: "", winHide: false, oldrc: false, name: "controlled long-running child", outputs: 1, wires: [[]] },
    ];
    const started = await request("/start", { runId: "sigterm-proof", attemptId: "sigterm-proof", flows: activeFlows, entry: "entry", input: { wait: true }, cwd: project });
    assert.equal(started.status, 202);
    await waitFor(() => workerDir() !== undefined);
    const dir = workerDir();
    assert.equal(fs.readlinkSync(join(dir, "node_modules")), fs.realpathSync(runtime));
    let descendantPid;
    await waitFor(() => {
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try { if (fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) descendantPid = Number(entry); }
        catch (error) { if (! ["ENOENT", "ESRCH"].includes(error.code)) throw error; }
      }
      return descendantPid !== undefined;
    });
    child.kill("SIGTERM");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Host did not exit after SIGTERM")), 15000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    assert.equal(fs.existsSync(dir), false);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    assert.equal(child.signalCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise((resolve) => callback.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
