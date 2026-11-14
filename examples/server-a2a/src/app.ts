import express from "express";
import {
  AgentCard,
  HTTPAuthSecurityScheme,
  SecurityRequirement,
  SecurityScheme,
  TaskState,
} from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, restHandler } from "@a2a-js/sdk/server/express";
import { Backend } from "./backend.js";
import { ManagementExecutor } from "./agent-executor.js";

export function createApp(options: {
  token: string;
  backend: Backend;
  publicUrl: string;
  tokens?: ReadonlyMap<string, string>;
}) {
  const tokens = options.tokens ?? new Map([[options.token, "default"]]);
  const card: AgentCard = {
    name: "AaaS Management Agent",
    description: "Discovers and executes AaaS workflows.",
    supportedInterfaces: [
      {
        url: options.publicUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        tenant: "",
      },
    ],
    provider: undefined,
    version: "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      bearerAuth: SecurityScheme.fromJSON({
        scheme: {
          $case: "httpAuth",
          value: HTTPAuthSecurityScheme.fromJSON({
            scheme: "bearer",
            bearerFormat: "opaque",
          }),
        },
      }),
    },
    securityRequirements: [
      SecurityRequirement.fromJSON({ schemes: { bearerAuth: [] } }),
    ],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "workflow-management",
        name: "Workflow management",
        description:
          "List available workflows and execute a workflow as an A2A Task.",
        tags: ["workflows", "management"],
        examples: ["list workflows"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        securityRequirements: [
          SecurityRequirement.fromJSON({ schemes: { bearerAuth: [] } }),
        ],
      },
    ],
    signatures: [],
  };
  const userBuilder = async (request: express.Request) => {
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : "";
    const principal = tokens.get(token);
    return {
      get isAuthenticated() {
        return principal !== undefined;
      },
      get userName() {
        return principal ?? "unauthenticated";
      },
    };
  };
  const handler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new ManagementExecutor(options.backend),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      keepBusAliveStates: [
        TaskState.TASK_STATE_INPUT_REQUIRED,
        TaskState.TASK_STATE_AUTH_REQUIRED,
        TaskState.TASK_STATE_WORKING,
      ],
      validateInputModes: true,
    },
  );
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: handler }),
  );
  app.use((request, response, next) => {
    if (request.path === "/.well-known/agent-card.json") return next();
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : "";
    if (!tokens.has(token)) {
      response.setHeader("Content-Type", "application/a2a+json");
      return response.status(401).json({
        error: {
          code: 401,
          status: "UNAUTHENTICATED",
          message: "Unauthorized",
          details: [],
        },
      });
    }
    return next();
  });
  app.use("/", restHandler({ requestHandler: handler, userBuilder }));
  return app;
}
