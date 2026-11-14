import { Backend } from "./backend.js";
import { createApp } from "./app.js";

const token = process.env.A2A_TOKEN;
const backendUrl = process.env.AAS_URL;
const backendToken = process.env.AAS_TOKEN;
const port = Number(process.env.PORT ?? 3095);
if (
  !token ||
  !backendUrl ||
  !backendToken ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  throw new Error(
    "A2A_TOKEN, AAS_URL, AAS_TOKEN and a valid PORT are required",
  );
}
const backendAddress = new URL(backendUrl);
if (
  !["http:", "https:"].includes(backendAddress.protocol) ||
  backendAddress.username ||
  backendAddress.password
) {
  throw new Error(
    "AAS_URL must be an HTTP(S) URL without embedded credentials",
  );
}

const tokens = new Map<string, string>([[token, "default"]]);
for (const pair of (process.env.A2A_TOKENS ?? "").split(",").filter(Boolean)) {
  const separator = pair.indexOf(":");
  if (separator < 1 || separator === pair.length - 1)
    throw new Error("A2A_TOKENS must contain principal:token entries");
  const principal = pair.slice(0, separator);
  const credential = pair.slice(separator + 1);
  if (tokens.has(credential) || [...tokens.values()].includes(principal))
    throw new Error("A2A_TOKENS contains duplicate credentials or principals");
  tokens.set(credential, principal);
}
const app = createApp({
  token,
  tokens,
  backend: new Backend(backendUrl, backendToken),
  publicUrl: process.env.A2A_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
});
const server = app.listen(port, "127.0.0.1");
server.on("listening", () =>
  process.stdout.write(`A2A HTTP+JSON listening on 127.0.0.1:${port}\n`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
