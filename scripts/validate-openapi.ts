import SwaggerParser from "@apidevtools/swagger-parser";
import { readFileSync } from "node:fs";
import { publicPaths } from "../packages/contract/src/index.js";
const raw = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
);
const spec = await SwaggerParser.validate(
  new URL("../openapi.json", import.meta.url).pathname,
);
if (!("components" in spec)) throw new Error("OpenAPI 3 components required");
const operations = Object.values(spec.paths ?? {})
  .flatMap((path) => Object.values(path ?? {}))
  .filter((x) => x && typeof x === "object" && "responses" in x);
if (operations.length !== 33)
  throw new Error(`Expected 33 operations, got ${operations.length}`);
if (JSON.stringify(spec.security) !== JSON.stringify([{ bearerAuth: [] }]))
  throw new Error("Resource operations must require bearer authentication");
const creationBody = spec.paths?.["/api/v1/projects"]?.post?.requestBody;
if (!creationBody || !("required" in creationBody) || !creationBody.required)
  throw new Error("Project creation must require a JSON request body");
const cancellationBody =
  spec.paths?.["/api/v1/runs/{runId}/cancel"]?.post?.requestBody;
if (
  cancellationBody &&
  "required" in cancellationBody &&
  cancellationBody.required
)
  throw new Error("Run cancellation must allow an omitted request body");
for (const path of publicPaths) {
  if (JSON.stringify(spec.paths?.[path]?.get?.security) !== "[]")
    throw new Error(
      `Public operation must explicitly opt out of auth: ${path}`,
    );
}
for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  if ((publicPaths as readonly string[]).includes(path)) continue;
  for (const operation of Object.values(methods ?? {})) {
    if (
      operation &&
      typeof operation === "object" &&
      "responses" in operation &&
      "security" in operation &&
      JSON.stringify(operation.security) !==
        JSON.stringify([{ bearerAuth: [] }])
    )
      throw new Error(
        `Protected operation overrides bearer authentication: ${path}`,
      );
  }
}
for (const path of [
  "/api/v1/runs/{runId}/events/stream",
  "/api/v1/conversations/{conversationId}/events/stream",
]) {
  const streamResponse = spec.paths?.[path]?.get?.responses["200"];
  if (
    !streamResponse ||
    !("content" in streamResponse) ||
    !streamResponse.content?.["text/event-stream"]
  )
    throw new Error(`${path} must declare text/event-stream`);
  if (
    !spec.paths?.[path]?.get?.description?.includes("event_history_unavailable")
  )
    throw new Error(`${path} must document replay failure semantics`);
  // SwaggerParser resolves extension $refs in memory; inspect the checked-in wire spec.
  const media = raw.paths[path].get.responses["200"].content[
    "text/event-stream"
  ] as Record<string, unknown>;
  const link = media["x-sse-data-schema"] as { $ref?: string } | undefined;
  if (!link?.$ref?.startsWith("#/components/schemas/"))
    throw new Error(`${path} must link its typed SSE data payload`);
  const name = link.$ref.split("/").pop()!;
  if (!raw.components?.schemas?.[name])
    throw new Error(`${path} links a missing SSE payload schema`);
  const standards = media["x-sse-standard-events"] as
    { $ref: string }[] | undefined;
  if (
    !standards?.length ||
    standards.some(
      ({ $ref }) => !raw.components?.schemas?.[$ref.split("/").pop()!],
    )
  )
    throw new Error(`${path} must link its standard event schemas`);
}
for (const path of [
  "/api/v1/runs",
  "/api/v1/conversations/{conversationId}/messages",
]) {
  if (!spec.paths?.[path]?.post?.description?.includes("immediately readable"))
    throw new Error(`${path} must document accepted-run visibility`);
  if (!spec.paths?.[path]?.post?.description?.includes("24 hours"))
    throw new Error(`${path} must document idempotency duration`);
  if (!spec.paths?.[path]?.post?.responses["413"])
    throw new Error(`${path} must declare oversized payload rejection`);
}
if (
  !spec.paths?.[
    "/api/v1/interactions/{interactionId}/decisions"
  ]?.post?.description?.includes("24 hours")
)
  throw new Error("Decision idempotency must have the same duration");
for (const [path, method, code] of [
  ["/api/v1/workflows", "post", "201"],
  ["/api/v1/workflows/{workflowId}", "get", "200"],
  ["/api/v1/workflows/{workflowId}", "put", "200"],
] as const) {
  const response = spec.paths?.[path]?.[method]?.responses[code];
  if (!response || !("headers" in response) || !response.headers?.ETag)
    throw new Error(`${method} ${path} must declare ETag response header`);
}
if (!spec.paths?.["/api/v1/workflows/{workflowId}"]?.put?.responses["412"])
  throw new Error("Conditional workflow update must declare 412");
console.log(
  `Valid OpenAPI ${"openapi" in spec ? spec.openapi : "unknown"}: ${operations.length} operations`,
);
