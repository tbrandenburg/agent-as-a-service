const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable, PassThrough } = require("node:stream");
const { test } = require("node:test");
const { stop, start, workers, server, forwardWorkerOutput } = require("./supervisor.js");
const { addCoreProbes } = require("./core-probes.js");

test("Core cwd proof preserves the writer instruction and rejects invalid cwd evidence", () => {
  const tab = { configs: [], nodes: [{ id: "workflow-entry", wires: [["writer-agent"]] }] };
  addCoreProbes(tab, "core");
  const execute = (id, msg, errors = []) => {
    const node = tab.nodes.find((node) => node.id === id);
    return new Function("msg", "env", "node", node.func)(msg, { get: () => "/data/agent-work" }, { error: (error) => errors.push(error) });
  };
  const prompt = "In one sentence, draft a release note about A faster search index. Reply only with the sentence.";
  const msg = { runId: "proof", text: "A faster search index", payload: prompt };
  assert.deepEqual(tab.nodes[0].wires[0], ["aaas-probe-prompt"]);
  execute("aaas-probe-prompt", msg);
  msg.payload = "/data/agent-work\n";
  execute("aaas-probe-check", msg);
  assert.equal(msg.payload, msg.text);
  msg.cwdListing = { directory: "/data/agent-work", files: [msg.filename] };
  execute("aaas-probe-list-check", msg);
  assert.equal(msg.payload, prompt);
  assert.equal("aaasWriterPrompt" in msg, false);
  const errors = [];
  assert.equal(execute("aaas-probe-check", { payload: "/wrong\n" }, errors), null);
  assert.equal(execute("aaas-probe-list-check", { cwdListing: { directory: "/wrong", files: [] } }, errors), null);
  assert.equal(errors.length, 2);
});

test("native metrics require the opt-in switch and a run worker", () => {
  for (const [worker, metrics, expected] of [
    ["true", undefined, false],
    ["true", "false", false],
    ["true", "true", true],
    ["false", "true", false],
  ]) {
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./settings.js').logging.console))"], {
      cwd: __dirname,
      encoding: "utf8",
      env: { ...process.env, INTERNAL_TOKEN: "internal", NODE_RED_ADMIN_TOKEN: "admin", API_TOKEN: "public", WORKER_RUNTIME: worker, NODE_RED_WORKER_METRICS: metrics },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { level: "info", metrics: expected, audit: false });
  }
});

test("worker output labels fragmented stdout and stderr lines without changing native fields", async () => {
  const metric = '[metric] {"nodeid":"writer","event":"node.agent.receive","msgid":"message"}';
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => { out += chunk; });
  stderr.on("data", (chunk) => { err += chunk; });
  const lines = forwardWorkerOutput(Readable.from([metric.slice(0, 17), metric.slice(17) + "\r\nnext\npartial"]), stdout, "run-123");
  const errors = forwardWorkerOutput(Readable.from(["failure", " detail\n"]), stderr, "run-123");
  await Promise.all([once(lines, "close"), once(errors, "close")]);
  assert.equal(out, `[worker runId=run-123] ${metric}\n[worker runId=run-123] next\n[worker runId=run-123] partial\n`);
  assert.equal(err, "[worker runId=run-123] failure detail\n");
});

test("stop cleans already exited workers without waiting for a second exit event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aaas-stop-exited-"));
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  const id = "exited";
  let cleared = false;
  const timer = setTimeout(() => { cleared = true; }, 1000);
  workers.set(id, { child, dir, exited: true, exit: Promise.resolve(), timeout: timer });
  await stop(id);
  assert.equal(workers.has(id), false);
  assert.equal(cleared, false);
  await assert.rejects(readdir(dir), { code: "ENOENT" });
});

test("stop terminates a running process and removes only its worker data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aaas-stop-running-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const worker = { child, dir, exited: false, timeout: setTimeout(() => {}, 5000), exit: null };
  worker.exit = new Promise((resolve) => child.once("exit", () => { worker.exited = true; resolve(); }));
  workers.set("running", worker);
  await stop("running");
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(workers.has("running"), false);
  await assert.rejects(readdir(dir), { code: "ENOENT" });
});

test("stop terminates subprocesses owned by the isolated worker group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aaas-stop-group-"));
  const child = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const worker = { child, dir, group: child.pid, exited: false, timeout: setTimeout(() => {}, 5000), exit: null };
  worker.exit = new Promise((resolve) => child.once("exit", () => { worker.exited = true; resolve(); }));
  workers.set("group", worker);
  await stop("group");
  assert.equal(workers.has("group"), false);
  await assert.rejects(readdir(dir), { code: "ENOENT" });
  assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
});

test("replacement waits for exit and cleanup while a stopping worker holds the last slot", async () => {
  const dirs = await Promise.all(Array.from({ length: 4 }, () => mkdtemp(join(tmpdir(), "aaas-turnover-"))));
  let exit;
  let stopping = false;
  const child = { exitCode: null, signalCode: null, kill: () => { stopping = true; } };
  const worker = { child, dir: dirs[0], exited: false, timeout: setTimeout(() => {}, 5000) };
  worker.exit = new Promise((resolve) => { exit = () => { worker.exited = true; resolve(); }; });
  workers.set("finishing", worker);
  for (let index = 1; index < 4; index++) {
    workers.set(`active-${index}`, { child: { exitCode: 0 }, dir: dirs[index], exited: true, exit: Promise.resolve(), timeout: setTimeout(() => {}, 5000) });
  }
  try {
    const cleanup = stop("finishing");
    assert.equal(stopping, true);
    assert.equal(workers.size, 4);
    assert.ok(workers.get("finishing").stopping);
    const stopPromise = workers.get("finishing").stopping;
    await Promise.resolve();
    assert.equal(workers.get("finishing").stopping, stopPromise);
    const replacement = start({ runId: "replacement" }, async () => {
      assert.equal(workers.has("finishing"), false);
      assert.equal(workers.size, 3);
      workers.set("replacement", { child: { exitCode: 0 }, dir: await mkdtemp(join(tmpdir(), "aaas-replacement-")), exited: true, exit: Promise.resolve(), timeout: setTimeout(() => {}, 5000) });
      assert.equal(workers.size, 4);
    });
    let settled = false;
    void replacement.finally(() => { settled = true; }).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(workers.size, 4);
    exit();
    await cleanup;
    await replacement;
    assert.equal(workers.size, 4);
    await assert.rejects(readdir(dirs[0]), { code: "ENOENT" });
  } finally {
    exit();
    for (const id of workers.keys()) await stop(id);
  }
});

test("two waiting replacements compete for one released slot without exceeding the limit", async () => {
  const dirs = await Promise.all(Array.from({ length: 4 }, () => mkdtemp(join(tmpdir(), "aaas-contended-"))));
  let finish;
  const finishing = { child: { exitCode: null, signalCode: null, kill: () => {} }, dir: dirs[0], exited: false, timeout: setTimeout(() => {}, 5000) };
  finishing.exit = new Promise((resolve) => { finish = () => { finishing.exited = true; resolve(); }; });
  workers.set("finishing", finishing);
  for (let index = 1; index < 4; index++) {
    workers.set(`active-${index}`, { child: { exitCode: 0 }, dir: dirs[index], exited: true, exit: Promise.resolve(), timeout: setTimeout(() => {}, 5000) });
  }
  const launched = [];
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  const launch = async ({ runId }) => {
    launched.push(runId);
    if (launched.length === 1) await launchGate;
    const dir = await mkdtemp(join(tmpdir(), "aaas-contender-"));
    workers.set(runId, { child: { exitCode: 0 }, dir, exited: true, exit: Promise.resolve(), timeout: setTimeout(() => {}, 5000) });
    assert.ok(workers.size <= 4, "more workers than capacity");
  };
  try {
    const cleanup = stop("finishing");
    const first = start({ runId: "first" }, launch);
    const second = start({ runId: "second" }, launch);
    await assert.rejects(start({ runId: "first" }, launch), /Duplicate/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(launched, []);
    finish();
    await cleanup;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launched.length, 1);
    await assert.rejects(start({ runId: launched[0] }, launch), /Duplicate/);
    assert.equal(workers.size, 3);
    releaseLaunch();
    if (launched[0] === "first") await first;
    else await second;
    assert.equal(workers.size, 4);
    const occupied = launched[0];
    await assert.rejects(start({ runId: occupied }, launch), /Duplicate/);
    await stop(occupied);
    await Promise.all([first, second]);
    assert.deepEqual(new Set(launched), new Set(["first", "second"]));
    assert.equal(workers.size, 4);
  } finally {
    releaseLaunch();
    finish();
    for (const id of workers.keys()) await stop(id);
  }
});

test("failed cleanup keeps capacity occupied and stop can retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aaas-retry-stop-"));
  const worker = { child: { exitCode: 0 }, dir: "/dev/null/child", exited: true, exit: Promise.resolve(), timeout: setTimeout(() => {}, 5000) };
  workers.set("retry", worker);
  await assert.rejects(stop("retry"), { code: "ENOTDIR" });
  assert.equal(workers.has("retry"), true);
  worker.dir = dir;
  await stop("retry");
  assert.equal(workers.has("retry"), false);
  await assert.rejects(readdir(dir), { code: "ENOENT" });
});

test("failed startup releases its reservation for another waiting worker", async () => {
  const dirs = await Promise.all(Array.from({ length: 4 }, () => mkdtemp(join(tmpdir(), "aaas-start-failure-"))));
  for (let index = 0; index < 4; index++) {
    workers.set(`active-${index}`, { child: { exitCode: 0 }, dir: dirs[index], exited: true, exit: Promise.resolve(), timeout: setTimeout(() => {}, 5000) });
  }
  try {
    const failed = start({ runId: "failed-start" }, async () => { throw new Error("startup failed"); });
    let launched = false;
    const next = start({ runId: "next-start" }, async () => { launched = true; });
    await stop("active-0");
    await assert.rejects(failed, /startup failed/);
    await next;
    assert.equal(launched, true);
    assert.equal(workers.size, 3);
  } finally {
    for (const id of workers.keys()) await stop(id);
  }
});

test.after(() => server.close());
