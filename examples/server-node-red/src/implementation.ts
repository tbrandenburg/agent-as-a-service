import { randomUUID } from "node:crypto";
import { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";
import { notImplementedRoutes } from "../../server-express/src/index.js";
import type { ApiImplementation } from "../../server-express/src/index.js";

type Run = z.infer<typeof schemas.run>;
type Event = z.infer<typeof schemas.event>;

const workflow: z.infer<typeof schemas.definition> = {
  id: "node-red-demo",
  name: "Node-RED demo",
  engine: "node-red",
  specificationVersion: "5.x",
  specification: { endpoint: "/workflow/demo" },
  version: 1,
  readOnly: true,
  createdAt: new Date().toISOString(),
};

const missing = (name: string) => ({
  status: 404 as const,
  body: { error: { code: "not_found", message: `${name} was not found` } },
});
const invalid = (message: string) => ({
  status: 400 as const,
  body: { error: { code: "invalid_input", message } },
});

export class NodeRedBackend {
  private readonly runs = new Map<string, Run>();
  private readonly events = new Map<string, Event[]>();
  private readonly keys = new Map<string, { body: string; run: Run }>();

  constructor(private readonly url: string) {}

  private update(run: Run, status: Run["status"], patch: Partial<Run> = {}) {
    Object.assign(run, patch, { status, updatedAt: new Date().toISOString() });
    const events = this.events.get(run.id)!;
    events.push({
      id: randomUUID(),
      runId: run.id,
      sequence: events.length + 1,
      type: "run.updated",
      data: { status },
      createdAt: new Date().toISOString(),
    });
  }

  private async execute(run: Run, text: string) {
    this.update(run, "running");
    try {
      const response = await fetch(`${this.url}/workflow/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: run.id, input: { text } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error("Node-RED returned a non-success response");
      const result = schemas.run
        .pick({ output: true })
        .safeParse(await response.json());
      if (!result.success || typeof result.data.output !== "string")
        throw new Error("Node-RED returned an invalid result");
      this.update(run, "completed", { output: result.data.output });
    } catch {
      this.update(run, "failed", {
        error: {
          code: "workflow_failed",
          message: "The workflow could not complete this run",
        },
      });
    }
  }

  implementation(): ApiImplementation {
    return {
      ...notImplementedRoutes,
      workflows: {
        ...notImplementedRoutes.workflows,
        listWorkflows: async ({ query }) => ({
          status: 200,
          body: {
            items: !query.projectId && !query.cursor ? [workflow] : [],
            nextCursor: null,
          },
        }),
        getWorkflow: async ({ params }) =>
          params.workflowId === workflow.id
            ? { status: 200, body: workflow }
            : missing("Workflow"),
        validateWorkflow: async ({ body }) => {
          const errors: string[] = [];
          if (body.projectId) errors.push("Projects are not supported");
          if (body.engine !== workflow.engine)
            errors.push("engine must be node-red");
          if (body.specificationVersion !== workflow.specificationVersion)
            errors.push("specificationVersion must be 5.x");
          if (
            typeof body.specification !== "object" ||
            body.specification.endpoint !== "/workflow/demo"
          )
            errors.push("specification.endpoint must be /workflow/demo");
          return { status: 200, body: { valid: errors.length === 0, errors } };
        },
      },
      runs: {
        ...notImplementedRoutes.runs,
        startRun: async ({ body, headers }) => {
          if (
            body.target?.kind === "workflow" &&
            body.target.workflowId !== workflow.id
          )
            return missing("Workflow");
          if (body.target?.kind !== "workflow")
            return invalid(
              "Only the node-red-demo workflow target is supported",
            );
          if (body.projectId || body.conversationId || body.engineOptions)
            return invalid(
              "Projects, conversations and engine options are not supported",
            );
          const input = body.input;
          const text =
            input && typeof input === "object" && !Array.isArray(input)
              ? input.text
              : undefined;
          if (typeof text !== "string" || !text.trim())
            return invalid("input.text must be a non-empty string");
          const key = headers["idempotency-key"];
          const encoded = JSON.stringify(body);
          const prior = key ? this.keys.get(key) : undefined;
          if (prior) {
            if (prior.body !== encoded)
              return {
                status: 409,
                body: {
                  error: {
                    code: "idempotency_conflict",
                    message: "Key already used for another body",
                  },
                },
              };
            return { status: 202, body: { run: structuredClone(prior.run) } };
          }
          const now = new Date().toISOString();
          const run: Run = {
            id: randomUUID(),
            target: body.target,
            workflowVersion: workflow.version,
            status: "queued",
            input,
            createdAt: now,
            updatedAt: now,
          };
          this.runs.set(run.id, run);
          this.events.set(run.id, []);
          this.update(run, "queued");
          const accepted = structuredClone(run);
          if (key) this.keys.set(key, { body: encoded, run: accepted });
          setImmediate(() => void this.execute(run, text));
          return { status: 202, body: { run: accepted } };
        },
        getRun: async ({ params }) => {
          const run = this.runs.get(params.runId);
          return run
            ? { status: 200, body: { run: structuredClone(run) } }
            : missing("Run");
        },
        listEvents: async ({ params, query }) => {
          const events = this.events.get(params.runId);
          return events
            ? {
                status: 200,
                body: events
                  .filter((event) => event.sequence > query.after)
                  .slice(0, query.limit),
              }
            : missing("Run");
        },
      },
    };
  }
}
