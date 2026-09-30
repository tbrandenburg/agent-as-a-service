const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { stop, workers, server } = require("./supervisor.js");

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

test.after(() => server.close());
