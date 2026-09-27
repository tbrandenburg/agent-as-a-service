import { readFileSync } from "node:fs";
import { contract } from "@agent-as-a-service/contract";
import type { ApiImplementation } from "../routes.js";

type Route = { method: string; path: string };
function handlers(tree: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tree).map(([operation, value]) => {
      if (value && typeof value === "object" && "method" in value) {
        const route = value as Route;
        if (operation === "getOpenApiDocument")
          return [
            operation,
            async () => ({
              status: 200,
              body: JSON.parse(
                readFileSync(
                  new URL("../../../../openapi.json", import.meta.url),
                  "utf8",
                ),
              ),
            }),
          ];
        if (operation === "getHealth")
          return [
            operation,
            async () => ({
              status: 200,
              body: {
                status: "ok",
                version: "1.0.0",
              },
            }),
          ];
        if (operation === "getStatus")
          return [
            operation,
            async () => ({
              status: 200,
              body: {
                environment: ["HOST", "PORT", "API_TOKEN"].map((name) => ({
                  name,
                  set: process.env[name] !== undefined,
                })),
              },
            }),
          ];
        return [
          operation,
          async () => ({
            status: 501,
            body: {
              error: {
                code: "not_implemented",
                message: `${operation} has no backend implementation`,
                details: { method: route.method, path: route.path },
              },
            },
          }),
        ];
      }
      return [operation, handlers(value as Record<string, unknown>)];
    }),
  );
}
/** Default demonstration backend; another implementation can replace it. */
export const notImplementedRoutes = handlers(
  contract as unknown as Record<string, unknown>,
) as unknown as ApiImplementation;
