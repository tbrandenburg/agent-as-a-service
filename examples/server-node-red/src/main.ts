import { createApp } from "../../server-express/src/index.js";
import { NodeRedBackend } from "./implementation.js";

const token = process.env.API_TOKEN ?? "dev-token";
const port = Number(process.env.PORT ?? 3093);
const host = process.env.HOST ?? "127.0.0.1";
const url = process.env.NODE_RED_URL ?? "http://127.0.0.1:1880";
const server = createApp({
  token,
  implementation: new NodeRedBackend(url).implementation(),
}).listen(port, host, () =>
  console.log(`Node-RED example listening on ${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => server.close(() => process.exit(0)));
