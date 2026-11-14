import http from "node:http";

const target = new URL(process.env.A2A_TARGET_URL ?? "");
const token = process.env.A2A_TOKEN;
const port = Number(process.env.A2A_PROXY_PORT ?? "3096");
if (
  !token ||
  target.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
  target.username ||
  target.password ||
  target.pathname !== "/" ||
  target.search ||
  target.hash ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  throw new Error("A2A_TOKEN, a loopback HTTP target, and valid A2A_PROXY_PORT are required");
}

const proxy = http.createServer(async (request, response) => {
  const upstream = new URL(request.url ?? "/", target);
  if (upstream.origin !== target.origin) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("Invalid proxy target");
    return;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value && key !== "host" && key !== "authorization") headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  if (!upstream.pathname.endsWith("/.well-known/agent-card.json")) headers.set("authorization", `Bearer ${token}`);
  try {
    const result = await fetch(upstream, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request }),
      // Node's fetch requires this for streaming request bodies.
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { duplex: "half" }),
    });
    const body = await result.arrayBuffer();
    const contentType = result.headers.get("content-type") ?? "";
    if (upstream.pathname.endsWith("/.well-known/agent-card.json") && contentType.includes("json")) {
      const card = JSON.parse(new TextDecoder().decode(body));
      for (const binding of card.supportedInterfaces ?? []) binding.url = `http://127.0.0.1:${port}`;
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(card));
      return;
    }
    const responseHeaders = Object.fromEntries(result.headers.entries());
    delete responseHeaders["content-encoding"];
    delete responseHeaders["content-length"];
    delete responseHeaders["transfer-encoding"];
    response.writeHead(result.status, responseHeaders);
    response.end(Buffer.from(body));
  } catch {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("TCK forwarding failed");
  }
});
proxy.listen(port, "127.0.0.1");
proxy.on("listening", () => process.stdout.write(`A2A TCK auth proxy listening on 127.0.0.1:${port}\n`));
