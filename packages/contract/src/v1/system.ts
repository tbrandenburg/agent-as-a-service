import { initContract } from "@ts-rest/core";
import { z } from "zod";
import * as c from "./schemas/common.js";
const t = initContract();
export const system = t.router({
  getHealth: {
    method: "GET",
    path: "/api/v1/health",
    responses: {
      200: z.object({
        status: z.enum(["ok", "degraded"]),
        version: z.string(),
        database: z.enum(["ok", "unavailable"]).optional(),
      }),
      ...c.publicSystemErrors,
    },
    summary: "Get application health",
  },
  getStatus: {
    method: "GET",
    path: "/api/v1/status",
    responses: {
      200: z.object({
        environment: z.array(
          z.object({ name: z.string().min(1), set: z.boolean() }),
        ),
      }),
      ...c.statusErrors,
    },
    summary:
      "Get authenticated configuration diagnostics; names and presence only, never values",
  },
  getOpenApiDocument: {
    method: "GET",
    path: "/api/v1/openapi.json",
    responses: {
      200: z.object({
        openapi: z.string(),
        info: z.object({ title: z.string(), version: z.string() }),
        paths: z.record(z.unknown()),
      }),
      ...c.publicSystemErrors,
    },
    summary: "Get generated OpenAPI documentation",
  },
});
