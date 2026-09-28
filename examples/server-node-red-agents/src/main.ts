import express from "express";
import { timingSafeEqual } from "node:crypto";
import { createApp } from "../../server-express/src/index.js";
import { AgentsBackend, httpExecutor } from "./backend.js";

const token = process.env.API_TOKEN ?? "dev-token";
const internalToken = process.env.INTERNAL_TOKEN;
if (!internalToken || internalToken === token)
  throw new Error("A distinct INTERNAL_TOKEN is required");
const backend = new AgentsBackend(
  httpExecutor(process.env.NODE_RED_URL ?? "http://node-red:1880"),
);
const internal = express();
internal.use(express.json({ limit: "1mb" }));
internal.post("/checkpoint", (request, response) => {
  const supplied = Buffer.from(
    request.headers.authorization?.replace(/^Bearer /, "") ?? "",
  );
  const expected = Buffer.from(internalToken);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  const result = backend.checkpoint(request.body);
  response.status(result.status).json(result.body);
});
const privateServer = internal.listen(3095, "0.0.0.0");
const publicServer = createApp({
  token,
  implementation: backend.implementation(),
}).listen(3094, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    publicServer.close(() => privateServer.close(() => process.exit(0)));
  });
