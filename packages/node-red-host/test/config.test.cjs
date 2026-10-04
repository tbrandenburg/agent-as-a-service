const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { resolveConfig, resolveNodeRedModules } = require("../lib/config.cjs");

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
  else assert.match(result.stderr, /Configured NODE_RED_MODULES does not contain Node-RED and Express/);
  assert.equal(typeof resolveNodeRedModules, "function");
});

test("a local Node-RED runtime is preferred to the stock image fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "aaas-host-runtime-"));
  const modules = join(root, "node_modules");
  const fs = require("node:fs");
  try {
    fs.mkdirSync(join(modules, "node-red"), { recursive: true });
    fs.mkdirSync(join(modules, "express"), { recursive: true });
    fs.writeFileSync(join(modules, "node-red", "package.json"), JSON.stringify({ name: "node-red" }));
    fs.writeFileSync(join(modules, "express", "package.json"), JSON.stringify({ name: "express" }));
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
