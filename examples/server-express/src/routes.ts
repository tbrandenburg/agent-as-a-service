import { createExpressEndpoints, initServer } from "@ts-rest/express";
import type { Express } from "express";
import { contract } from "@agent-as-a-service/contract";

/** Implement this type to supply a backend for the HTTP transport. */
export type ApiImplementation = Parameters<
  typeof createExpressEndpoints<typeof contract>
>[1];

export function registerContract(
  app: Express,
  implementation: ApiImplementation,
) {
  const server = initServer();
  createExpressEndpoints(
    contract,
    server.router(contract, implementation),
    app,
    {
      responseValidation: true,
      logInitialization: false,
      requestValidationErrorHandler: (_error, _request, response) =>
        response.status(400).json({
          error: {
            code: "invalid_request",
            message: "Request failed schema validation",
          },
        }),
    },
  );
}
