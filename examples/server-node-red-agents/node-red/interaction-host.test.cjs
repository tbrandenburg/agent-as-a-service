const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { serializable, validateResume } = require("./interaction-host.js");

test("checkpoint serialization preserves VM JSON objects and rejects lossy runtime state", () => {
  assert.equal(serializable(vm.runInNewContext('({nested:[null,true,3,"original"]})')), true);
  const cycle = {}; cycle.self = cycle;
  const sparse = []; sparse.length = 2;
  const compensated = []; compensated.length = 1; compensated.extra = "lost";
  class RuntimeState { constructor() { this.value = 1; } }
  const getter = {}; Object.defineProperty(getter, "secret", { enumerable: true, get() { throw new Error("Getter must not be invoked"); } });
  for (const value of [cycle, getter, compensated, new RuntimeState(), { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: () => {} }, { value: new Date() }, { value: Buffer.from("x") }, { value: new Map() }, { value: sparse }]) assert.equal(serializable(value), false);
});

test("corrupt primitive continuation messages fail before runtime node lookup", () => {
  const RED = { nodes: { getNode() { throw new Error("Unexpected node lookup"); } } };
  for (const msg of ["string", 1, true, null, []]) assert.throws(() => validateResume(RED, { msg }, "/unused"), /Invalid continuation message/);
});
