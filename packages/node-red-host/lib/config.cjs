const { existsSync, statSync } = require("node:fs");
const { realpathSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { createRequire } = require("node:module");

const packageDir = resolve(__dirname, "..");

function resolveNodeRedModules() {
  const configured = process.env.NODE_RED_MODULES;
  const candidates = configured ? [resolve(configured)] : [];
  if (!configured) {
    try {
      candidates.push(dirname(dirname(require.resolve("node-red/package.json", { paths: [process.cwd()] }))));
    } catch { /* Try the official image path below. */ }
    candidates.push("/usr/src/node-red/node_modules");
  }
  for (const candidate of candidates) {
    const modules = resolve(candidate);
    try {
      const nodeRedRequire = createNodeRedRequire(modules);
      nodeRedRequire("node-red");
      const expressPath = nodeRedRequire.resolve("express");
      nodeRedRequire(expressPath);
      return realpathSync(modules);
    } catch { /* Try the next runtime candidate. */ }
  }
  if (configured) throw new Error(`Configured NODE_RED_MODULES does not contain a loadable Node-RED runtime with Express: ${resolve(configured)}`);
  throw new Error("Unable to resolve Node-RED and Express; set NODE_RED_MODULES to their shared node_modules directory");
}

function createNodeRedRequire(modules) {
  return createRequire(require.resolve(join(modules, "node-red")));
}

function callbackDestination(path) {
  const base = process.env.WORKER_CALLBACK_URL;
  if (!base || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid callback destination");
  return `${base.replace(/\/+$/, "")}${path}`;
}

function resolveConfig() {
  const internalToken = process.env.INTERNAL_TOKEN;
  if (!internalToken) throw new Error("INTERNAL_TOKEN is required");
  const callbackBase = process.env.WORKER_CALLBACK_URL;
  if (!callbackBase) throw new Error("WORKER_CALLBACK_URL is required");
  let callbackUrl;
  try {
    const parsed = new URL(callbackBase);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    if (!/^\/+$/u.test(parsed.pathname)) throw new Error();
    callbackUrl = parsed.origin;
  } catch {
    throw new Error("WORKER_CALLBACK_URL must be an HTTP(S) base URL");
  }
  const projectsRoot = resolve(process.env.PROJECTS_ROOT || "/data/projects");
  const globalWorkRoot = resolve(process.env.GLOBAL_WORK_ROOT || "/data/agent-work");
  for (const root of [projectsRoot, globalWorkRoot]) {
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Configured working root is not a directory: ${root}`);
  }
  const paletteModules = resolve(process.env.PALETTE_NODE_MODULES || "/data/node_modules");
  if (!existsSync(paletteModules) || !statSync(paletteModules).isDirectory()) throw new Error(`Palette node_modules directory does not exist: ${paletteModules}`);
  return {
    internalToken,
    callbackUrl,
    projectsRoot,
    globalWorkRoot,
    maxWorkers: Number(process.env.MAX_WORKERS ?? "4"),
    workerTimeoutMs: Number(process.env.WORKER_TIMEOUT_MS || 450_000),
    paletteModules,
  };
}

module.exports = { packageDir, resolveConfig, resolveNodeRedModules, createNodeRedRequire, callbackDestination };
