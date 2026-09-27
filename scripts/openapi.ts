import {
  isAppRoute,
  isAppRouteNoBody,
  isAppRouteOtherResponse,
  isZodType,
  type AppRoute,
  type AppRouter,
} from "@ts-rest/core";
import { createDocument, createSchema } from "zod-openapi";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import {
  contract,
  publicPaths,
  schemas,
} from "../packages/contract/src/index.js";
const paths: NonNullable<Parameters<typeof createDocument>[0]["paths"]> = {};
function addRoutes(router: AppRouter) {
  for (const [name, entry] of Object.entries(router)) {
    if (!isAppRoute(entry)) {
      addRoutes(entry);
      continue;
    }
    const route: AppRoute = entry;
    const path = route.path.replace(/:(\w+)/g, "{$1}");
    const method = route.method.toLowerCase() as
      "get" | "post" | "put" | "patch" | "delete";
    const pathParams =
      "pathParams" in route && isZodType(route.pathParams)
        ? route.pathParams
        : z.object(
            Object.fromEntries(
              [...path.matchAll(/\{(\w+)\}/g)].map(([, key]) => [
                key,
                z.string(),
              ]),
            ),
          );
    const responses = Object.fromEntries(
      Object.entries(route.responses).map(([status, response]) => [
        status,
        isAppRouteNoBody(response)
          ? { description: `${status} response` }
          : {
              description: `${status} response`,
              content: {
                [isAppRouteOtherResponse(response)
                  ? response.contentType
                  : "application/json"]: {
                  schema: isAppRouteOtherResponse(response)
                    ? response.body
                    : response,
                },
              },
            },
      ]),
    );
    const operation = {
      operationId: name,
      summary: route.summary,
      description: route.description,
      requestParams: {
        path: pathParams,
        ...("query" in route && isZodType(route.query)
          ? { query: route.query }
          : {}),
        ...("headers" in route && isZodType(route.headers)
          ? { header: route.headers }
          : {}),
      },
      ...("body" in route && isZodType(route.body)
        ? {
            requestBody: {
              required: !route.body.isOptional(),
              content: { "application/json": { schema: route.body } },
            },
          }
        : {}),
      responses,
    };
    paths[path] ??= {};
    Object.assign(paths[path], { [method]: operation });
  }
}
addRoutes(contract);
const spec = createDocument({
  openapi: "3.0.2",
  info: { title: "Agent as a Service API", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:3091" }],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  security: [{ bearerAuth: [] }],
});
// Generate SSE JSON payload schemas with the same Zod converter as the API.
const eventSchemas = {
  ConversationEvent: schemas.conversationEvent,
  RunEvent: schemas.event,
  MessageDeltaEvent: schemas.messageDeltaEvent,
  MessageCreatedEvent: schemas.messageCreatedEvent,
  ConversationRunUpdatedEvent: schemas.conversationRunUpdatedEvent,
  RunUpdatedEvent: schemas.runUpdatedEvent,
};
const eventComponents = Object.fromEntries(
  Object.entries(eventSchemas).map(([name, schema]) => [
    name,
    createSchema(schema, { openapi: "3.0.2" }).schema,
  ]),
);
spec.components ??= {};
spec.components.schemas = {
  ...spec.components.schemas,
  ...eventComponents,
} as typeof spec.components.schemas;
const specPaths = spec.paths ?? (spec.paths = {});
// ts-rest exposes the SSE content type at runtime but omits it from generated OpenAPI.
for (const [path, description, eventName, standardNames] of [
  [
    "/api/v1/runs/{runId}/events/stream",
    "Ordered run events as Server-Sent Events",
    "RunEvent",
    ["RunUpdatedEvent"],
  ],
  [
    "/api/v1/conversations/{conversationId}/events/stream",
    "Ordered conversation events as Server-Sent Events",
    "ConversationEvent",
    ["MessageDeltaEvent", "MessageCreatedEvent", "ConversationRunUpdatedEvent"],
  ],
] as const) {
  const stream = specPaths[path]?.get;
  if (!stream?.responses) throw new Error(`Missing SSE operation: ${path}`);
  stream.responses["200"] = {
    description,
    content: {
      "text/event-stream": {
        schema: { type: "string" },
        "x-sse-data-schema": { $ref: `#/components/schemas/${eventName}` },
        "x-sse-standard-events": standardNames.map((name) => ({
          $ref: `#/components/schemas/${name}`,
        })),
      },
    },
  };
}
// ts-rest models JSON responses but has no response-header DSL.
for (const [method, path, status] of [
  ["get", "/api/v1/workflows/{workflowId}", "200"],
  ["post", "/api/v1/workflows", "201"],
  ["put", "/api/v1/workflows/{workflowId}", "200"],
] as const) {
  const route =
    method === "post"
      ? contract.workflows.createWorkflow
      : method === "put"
        ? contract.workflows.updateWorkflow
        : contract.workflows.getWorkflow;
  if (!route.metadata.responseEtag)
    throw new Error(`ETag metadata missing: ${path}`);
  const response = specPaths[path]?.[method]?.responses?.[status];
  if (!response) throw new Error(`ETag response missing: ${path}`);
  response.headers = {
    ETag: {
      description: 'Strong version tag, e.g. "v1"',
      schema: { type: "string", pattern: '^"v[1-9][0-9]*"$' },
    },
  };
}
for (const path of publicPaths) {
  const operation = specPaths[path]?.get;
  if (operation) operation.security = [];
}
writeFileSync(
  new URL("../openapi.json", import.meta.url),
  JSON.stringify(spec, null, 2) + "\n",
);
