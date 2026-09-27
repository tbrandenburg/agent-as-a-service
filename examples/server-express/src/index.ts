import express from "express";
import { timingSafeEqual } from "node:crypto";
import { publicPaths } from "@agent-as-a-service/contract";
import { notImplementedRoutes } from "./adapters/not-implemented.js";
import { registerContract, type ApiImplementation } from "./routes.js";

export { registerContract, type ApiImplementation } from "./routes.js";
export { notImplementedRoutes } from "./adapters/not-implemented.js";

export function createApp(options: {
  token: string;
  implementation?: ApiImplementation;
}) {
  const app = express();
  app.use((request, response, next) => {
    if (
      request.path === "/health" ||
      (publicPaths as readonly string[]).includes(request.path)
    )
      return next();
    const supplied =
      request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const expected = Buffer.from(options.token);
    const actual = Buffer.from(supplied);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      response
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="agent-as-a-service"')
        .json({
          error: {
            code: "unauthorized",
            message: "Valid bearer token required",
          },
        });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  registerContract(app, options.implementation ?? notImplementedRoutes);
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 413
      ) {
        response.status(413).json({
          error: {
            code: "payload_too_large",
            message: "Request body exceeds server limit",
          },
        });
        return;
      }
      next(error);
    },
  );
  return app;
}
