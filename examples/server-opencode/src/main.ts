import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../../server-express/src/index.js";
import { OpenCodeBackend } from "./backend.js";
import { OpenCodeProvider } from "./provider.js";

const cwd = resolve(process.env.OPENCODE_DIR ?? process.cwd());
if (!statSync(cwd).isDirectory())
  throw new Error("OPENCODE_DIR must be an existing directory");
const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS ?? 300_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
  throw new Error("OPENCODE_TIMEOUT_MS must be a positive integer");
const model = process.env.OPENCODE_MODEL ?? "opencode/big-pickle";
if (model !== "opencode/big-pickle")
  throw new Error("OPENCODE_MODEL is fixed to opencode/big-pickle");
const token = process.env.API_TOKEN ?? "dev-token";
const port = Number(process.env.PORT ?? 3092);
const host = process.env.HOST ?? "127.0.0.1";
const backend = new OpenCodeBackend(
  new OpenCodeProvider(cwd, timeoutMs, model),
);
const server = createApp({
  token,
  implementation: backend.implementation(),
}).listen(port, host, () => {
  console.log(
    `opencode example listening on http://${host}:${port}; cwd=${cwd}; model=${model}; timeout=${timeoutMs}ms`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
