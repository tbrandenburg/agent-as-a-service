import { randomUUID } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";
import { notImplementedRoutes } from "../../server-express/src/index.js";
import type { ApiImplementation } from "../../server-express/src/routes.js";

type Run = z.infer<typeof schemas.run>;
type Generate = typeof generateText;

const target = { kind: "agent", id: "openai/gpt-6-luna" } as const;
const problem = (status: 400 | 501 | 503, code: string, message: string) => ({
  status,
  body: { error: { code, message } },
});
const missing = () => ({
  status: 404 as const,
  body: { error: { code: "not_found", message: "Run was not found" } },
});

export function createBackend(
  generate: Generate = generateText,
): ApiImplementation {
  const runs = new Map<string, Run>();

  return {
    ...notImplementedRoutes,
    runs: {
      ...notImplementedRoutes.runs,
      startRun: async ({ body, headers }) => {
        if (headers["idempotency-key"] !== undefined)
          return problem(
            501,
            "not_implemented",
            "Idempotency keys are not supported by this example",
          );
        if (
          body.projectId !== undefined ||
          body.conversationId !== undefined ||
          body.engineOptions !== undefined
        )
          return problem(
            501,
            "not_implemented",
            "Project, conversation, and engine options are not supported",
          );
        if (body.target?.kind !== target.kind || body.target.id !== target.id)
          return problem(400, "invalid_input", "Unsupported run target");
        if (
          typeof body.input !== "string" ||
          body.input.trim().length === 0 ||
          body.input.length > 4096
        )
          return problem(
            400,
            "invalid_input",
            "Input must be nonempty text of at most 4096 characters",
          );

        try {
          const result = await generate({
            model: openai("gpt-6-luna"),
            prompt: body.input,
            maxRetries: 0,
            maxOutputTokens: 1024,
            timeout: 90_000,
          });
          if (
            typeof result.text !== "string" ||
            result.text.trim().length === 0 ||
            result.finishReason !== "stop"
          )
            return problem(
              503,
              "provider_unavailable",
              "The model did not return a complete text response",
            );

          const now = new Date().toISOString();
          const run: Run = {
            id: randomUUID(),
            target,
            input: body.input,
            output: result.text,
            status: "completed",
            createdAt: now,
            updatedAt: now,
          };
          runs.set(run.id, run);
          return { status: 202, body: { run } };
        } catch {
          return problem(
            503,
            "provider_unavailable",
            "The model could not complete this run",
          );
        }
      },
      getRun: async ({ params }) => {
        const run = runs.get(params.runId);
        return run ? { status: 200, body: { run } } : missing();
      },
    },
  };
}
