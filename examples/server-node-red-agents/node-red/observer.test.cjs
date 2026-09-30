const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createObserver } = require("./observer.js");

test("matches async and parallel completions by message object and destination, never _msgid", async () => {
  const callbacks = new Map();
  const batches = [];
  const observer = createObserver({ add: (name, callback) => callbacks.set(name.split(".")[0], callback) }, "run-1", async (batch) => { batches.push(...batch.observations); });
  const receive = callbacks.get("onReceive");
  const complete = callbacks.get("onComplete");
  const send = callbacks.get("onSend");
  const first = { _msgid: "same", payload: "secret" };
  const second = { _msgid: "same", payload: "other secret" };
  receive({ msg: first, destination: { id: "writer" } }); // pre-dispatch readiness
  observer.activate();
  send([{ msg: first, source: { id: "source" } }]);
  receive({ msg: first, destination: { id: "writer" } });
  receive({ msg: second, destination: { id: "writer" } });
  receive({ msg: first, destination: { id: "reviewer" } });
  complete({ msg: second, node: { id: "writer" }, error: new Error("caught") });
  complete({ msg: first, node: { id: "reviewer" } });
  complete({ msg: first, node: { id: "writer" } });
  receive({ msg: first, destination: { id: "writer" } });
  complete({ msg: first, node: { id: "writer" } });
  receive({ msg: second, destination: { id: "legacy" } });
  const drained = await observer.drain();
  assert.equal(drained.incomplete, undefined);
  assert.deepEqual(batches.map(({ type, nodeId, status }) => [type, nodeId, status]), [
    ["sent", "source", undefined], ["received", "writer", "running"],
    ["received", "writer", "running"], ["received", "reviewer", "running"],
    ["completed", "writer", "failed"], ["completed", "reviewer", "completed"],
    ["completed", "writer", "completed"], ["received", "writer", "running"],
    ["completed", "writer", "completed"], ["received", "legacy", "running"],
  ]);
  assert.notEqual(batches[1].executionId, batches[2].executionId);
  assert.equal(batches[1].executionId, batches[6].executionId);
  assert.equal(batches[2].executionId, batches[4].executionId);
  assert.equal(JSON.stringify(batches).includes("secret"), false);
});

test("ambiguous same-object deliveries cannot be assigned a fabricated completion", async () => {
  const callbacks = new Map();
  const batches = [];
  const observer = createObserver({ add: (name, callback) => callbacks.set(name.split(".")[0], callback) }, "run-2", async (batch) => { batches.push(...batch.observations); });
  observer.activate();
  const msg = {};
  callbacks.get("onReceive")({ msg, destination: { id: "loop" } });
  callbacks.get("onReceive")({ msg, destination: { id: "loop" } });
  callbacks.get("onComplete")({ msg, node: { id: "loop" } });
  assert.equal((await observer.drain()).incomplete, "ambiguous_identity");
  assert.deepEqual(batches.map(({ type }) => type), ["received", "received"]);
});

test("callback interruption and bounded queue report incompleteness without blocking hooks", async () => {
  const callbacks = new Map();
  const observer = createObserver({ add: (name, callback) => callbacks.set(name.split(".")[0], callback) }, "run-3", async () => { throw new Error("network down"); }, 2);
  observer.activate();
  for (let index = 0; index < 3; index++) callbacks.get("onReceive")({ msg: {}, destination: { id: "node" } });
  assert.equal((await observer.drain()).incomplete, "queue_overflow");
});
