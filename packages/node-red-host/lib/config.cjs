const { existsSync, statSync } = require("node:fs");
const { realpathSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const packageDir = resolve(__dirname, "..");

function resolveNodeRedModules() {
  const configured = process.env.NODE_RED_MODULES;
  const candidates = configured ? [configured] : [];
  if (!configured) {
    try {
      candidates.push(dirname(dirname(require.resolve("node-red/package.json", { paths: [process.cwd()] }))));
    } catch { /* Try the official image path below. */ }
    candidates.push("/usr/src/node-red/node_modules");
  }
  for (const candidate of candidates) {
    const modules = resolve(candidate);
    if (existsSync(join(modules, "node-red/package.json")) && existsSync(join(modules, "express/package.json"))) return realpathSync(modules);
  }
  if (configured) throw new Error(`Configured NODE_RED_MODULES does not contain Node-RED and Express: ${resolve(configured)}`);
  throw new Error("Unable to resolve Node-RED and Express; set NODE_RED_MODULES to their shared node_modules directory");
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
    callbackUrl = callbackBase.replace(/\/$/, "");
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

module.exports = { packageDir, resolveConfig, resolveNodeRedModules };
