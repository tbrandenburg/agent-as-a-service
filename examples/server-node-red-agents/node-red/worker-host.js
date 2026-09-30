const http = require("node:http");
const express = require("/usr/src/node-red/node_modules/express");
const RED = require("/usr/src/node-red/node_modules/node-red");
const { join } = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const { createObserver } = require("./observer.js");

const [dir, port, runId] = process.argv.slice(2);
if (!dir || !Number.isSafeInteger(Number(port)) || !runId || !process.env.INTERNAL_TOKEN) throw new Error("Invalid worker host configuration");
process.env.NODE_RED_HOME ||= "/usr/src/node-red/node_modules/node-red";
const settings = require(join(dir, "settings.js"));
Object.assign(settings, { userDir: dir, settingsFile: join(dir, "settings.js"), uiHost: "127.0.0.1", uiPort: Number(port), httpAdminRoot: false, httpNodeRoot: "/" });
const app = express();
const server = http.createServer(app);
RED.init(server, settings);
const callback = async (body, path = "/node-observations") => {
  const response = await fetch(`http://api:3095${path}`, {
    method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Worker observation rejected (${response.status})`);
};
const observer = createObserver(RED.hooks, runId, callback);
const authenticate = (request, response, next) => {
  const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(process.env.INTERNAL_TOKEN);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return response.status(401).json({ error: "Unauthorized" });
  next();
};
app.post("/activate", authenticate, (_request, response) => { observer.activate(); response.json({ active: true }); });
app.post("/drain", authenticate, async (_request, response) => {
  const result = await observer.drain();
  try { await callback(result, "/node-drain"); response.json({ drained: true }); }
  catch { response.status(503).json({ drained: false }); }
});
app.use(RED.httpNode);
RED.start().then(() => server.listen(Number(port), "127.0.0.1")).catch((error) => { console.error("Worker startup failed", error); process.exit(1); });
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  void RED.stop().then(() => server.close(() => { process.exitCode = 0; })).catch((error) => { console.error("Worker shutdown failed", error); process.exitCode = 1; });
});
