import { randomUUID } from "node:crypto";
import { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";
import { notImplementedRoutes } from "../../server-express/src/index.js";
import type { ApiImplementation } from "../../server-express/src/index.js";

type Conversation = z.infer<typeof schemas.conversation>;
type Message = z.infer<typeof schemas.message>;
type Run = z.infer<typeof schemas.run>;
type Detail = z.infer<typeof schemas.runDetail>;
type Sent = z.infer<typeof schemas.sentMessage>;
type Event = z.infer<typeof schemas.event>;
type Agent = "writer" | "reviewer";
type Result = { reply: string; sessionID: string; resumed?: boolean };
type Checkpoint = Result & {
  runId: string;
  conversationId: string;
  prompt: string;
};
type Job = {
  run: Run;
  text: string;
  writer?: string;
  reviewer?: string;
  agent?: Agent;
  checkpoint?: Checkpoint;
};
type PrivateRequest = {
  runId: string;
  text: string;
  writerId?: string;
  reviewerId?: string;
  conversationId?: string;
  writerSession?: string;
  reviewerSession?: string;
  sessionID?: string;
};
type PrivateResponse = Result & { runId: string; conversationId: string };
export type Executor = (
  path: string,
  payload: PrivateRequest,
) => Promise<PrivateResponse>;

const workflow: z.infer<typeof schemas.definition> = {
  id: "node-red-demo",
  name: "Writer → reviewer",
  engine: "node-red",
  specificationVersion: "5.x",
  specification: { endpoint: "/workflow/agents" },
  version: 1,
  readOnly: true,
  createdAt: new Date().toISOString(),
};
const missing = (name: string) => ({
  status: 404 as const,
  body: { error: { code: "not_found", message: `${name} was not found` } },
});
const problem = (status: 400 | 409, code: string, message: string) => ({
  status,
  body: { error: { code, message } },
});
const invalid = (message: string) => problem(400, "invalid_input", message);
const agent = (value: unknown): value is Agent =>
  value === "writer" || value === "reviewer";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    record(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );

export const httpExecutor =
  (url: string): Executor =>
  async (path, payload) => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(360_000),
    });
    if (!response.ok) throw new Error("Private flow failed");
    return (await response.json()) as PrivateResponse;
  };

export class AgentsBackend {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message[]>();
  readonly runs = new Map<string, Detail>();
  readonly events = new Map<string, Event[]>();
  private readonly sessions = new Map<string, string>();
  private readonly busy = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly jobs = new Map<string, Job>();
  private readonly keys = new Map<
    string,
    { body: string; response: Detail | Sent; expires: number }
  >();

  constructor(private readonly executePrivate: Executor) {}

  private page<T>(items: T[], cursor: string | undefined, limit: number) {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (String(offset) !== cursor && cursor !== undefined)
    )
      return null;
    return {
      items: items.slice(offset, offset + limit),
      nextCursor: offset + limit < items.length ? String(offset + limit) : null,
    };
  }

  private create(
    agentId: Agent,
    title = `${agentId} conversation`,
  ): Conversation {
    const conversation: Conversation = {
      id: randomUUID(),
      agentId,
      title,
      createdAt: new Date().toISOString(),
    };
    this.conversations.set(conversation.id, conversation);
    this.messages.set(conversation.id, []);
    return conversation;
  }

  private add(
    id: string,
    role: Message["role"],
    content: string,
    runId: string,
  ) {
    const message: Message & { runId: string } = {
      id: randomUUID(),
      conversationId: id,
      role,
      content,
      runId,
      createdAt: new Date().toISOString(),
    };
    this.messages.get(id)!.push(message);
    return message;
  }

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

  private accept(
    target: Run["target"],
    input: Run["input"],
    links: Detail["conversations"],
    conversationId?: string,
  ) {
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      target,
      input,
      conversationId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      ...(target?.kind === "workflow" ? { workflowVersion: 1 } : {}),
    };
    const detail: Detail = { run, conversations: links };
    this.runs.set(run.id, detail);
    this.events.set(run.id, []);
    this.update(run, "queued");
    return detail;
  }

  private replay<T extends Detail | Sent>(
    path: string,
    key: string | undefined,
    body: unknown,
  ): { status: 202; body: T } | ReturnType<typeof problem> | undefined {
    if (!key) return undefined;
    const prior = this.keys.get(`POST\0${path}\0${key}`);
    if (!prior || prior.expires <= Date.now()) return undefined;
    return prior.body === canonical(body)
      ? { status: 202 as const, body: structuredClone(prior.response) as T }
      : problem(
          409,
          "idempotency_conflict",
          "Key already used for another body",
        );
  }

  private remember(
    path: string,
    key: string | undefined,
    body: unknown,
    response: Detail | Sent,
  ) {
    if (key)
      this.keys.set(`POST\0${path}\0${key}`, {
        body: canonical(body),
        response: structuredClone(response),
        expires: Date.now() + 86_400_000,
      });
  }

  private ownership(id: string, owner: Agent) {
    const conversation = this.conversations.get(id);
    return conversation?.agentId === owner;
  }

  private checkBusy(ids: string[]) {
    return ids.some((id) => this.busy.has(id) || this.blocked.has(id));
  }

  private validResult(
    value: unknown,
    requested: string | undefined,
  ): value is Result & Record<string, unknown> {
    return (
      record(value) &&
      text(value.reply) &&
      text(value.sessionID) &&
      (!requested || value.resumed === true)
    );
  }

  /** Only the private Compose listener calls this; never register on the public app. */
  checkpoint(value: unknown): {
    status: number;
    body: { acknowledged?: boolean; error?: string };
  } {
    if (
      !record(value) ||
      !text(value.runId) ||
      !text(value.conversationId) ||
      !text(value.prompt)
    )
      return { status: 400, body: { error: "Invalid checkpoint" } };
    const job = this.jobs.get(value.runId);
    if (
      !job ||
      !job.writer ||
      !job.reviewer ||
      job.run.status !== "running" ||
      value.conversationId !== job.writer
    )
      return { status: 409, body: { error: "Checkpoint rejected" } };
    if (job.checkpoint)
      return canonical({
        ...job.checkpoint,
        resumed: job.checkpoint.resumed === true,
      }) ===
        canonical({
          runId: value.runId,
          conversationId: value.conversationId,
          prompt: value.prompt,
          reply: value.reply,
          sessionID: value.sessionID,
          resumed: value.resumed === true,
        })
        ? { status: 200, body: { acknowledged: true } }
        : { status: 409, body: { error: "Conflicting checkpoint" } };
    if (!this.validResult(value, this.sessions.get(job.writer)))
      return { status: 409, body: { error: "Checkpoint rejected" } };
    const checkpoint: Checkpoint = {
      runId: value.runId,
      conversationId: value.conversationId,
      prompt: value.prompt,
      reply: value.reply,
      sessionID: value.sessionID,
      resumed: value.resumed === true,
    };
    this.add(job.writer, "assistant", checkpoint.reply, job.run.id);
    this.sessions.set(job.writer, checkpoint.sessionID);
    this.add(job.reviewer, "user", checkpoint.prompt, job.run.id);
    job.checkpoint = checkpoint;
    return { status: 200, body: { acknowledged: true } };
  }

  private async run(job: Job) {
    const { run, writer, reviewer, agent, text: prompt } = job;
    const ids = [writer, reviewer].filter((id): id is string => !!id);
    this.update(run, "running");
    let ambiguous = false;
    try {
      const id = agent === "writer" ? writer! : reviewer!;
      const requested = agent ? this.sessions.get(id) : undefined;
      const result = await this.executePrivate(
        agent ? `/agent/${agent}` : "/workflow/agents",
        {
          runId: run.id,
          text: prompt,
          ...(agent
            ? { conversationId: id, sessionID: requested }
            : {
                writerId: writer,
                reviewerId: reviewer,
                writerSession: this.sessions.get(writer!),
                reviewerSession: this.sessions.get(reviewer!),
              }),
        },
      );
      if (
        result.runId !== run.id ||
        result.conversationId !== (agent ? id : reviewer) ||
        !this.validResult(
          result,
          agent ? requested : this.sessions.get(reviewer!),
        ) ||
        (!agent && !job.checkpoint)
      ) {
        ambiguous = true;
        throw new Error("Invalid private result");
      }
      this.add(id, "assistant", result.reply, run.id);
      this.sessions.set(id, result.sessionID);
      this.update(run, "completed", {
        output: agent
          ? result.reply
          : `Writer: ${job.checkpoint!.reply}\nReviewer: ${result.reply}`,
      });
    } catch (error) {
      ambiguous ||=
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          error.name === "AbortError" ||
          error instanceof TypeError);
      this.update(run, "failed", {
        error: {
          code: agent ? "agent_failed" : "workflow_failed",
          message: "The run could not complete",
        },
      });
    } finally {
      if (ambiguous)
        this.blocked.add(
          agent ? ids[0]! : job.checkpoint ? reviewer! : writer!,
        );
      ids.forEach((id) => this.busy.delete(id));
      this.jobs.delete(run.id);
    }
  }

  implementation(): ApiImplementation {
    return {
      ...notImplementedRoutes,
      workflows: {
        ...notImplementedRoutes.workflows,
        listWorkflows: async ({ query }) => {
          const page = this.page(
            query.projectId ? [] : [workflow],
            query.cursor,
            query.limit,
          );
          return page ? { status: 200, body: page } : invalid("Invalid cursor");
        },
        getWorkflow: async ({ params }) =>
          params.workflowId === workflow.id
            ? { status: 200, body: workflow }
            : missing("Workflow"),
        validateWorkflow: async ({ body }) => {
          const errors = [
            body.projectId && "Projects are not supported",
            body.engine !== "node-red" && "engine must be node-red",
            body.specificationVersion !== "5.x" &&
              "specificationVersion must be 5.x",
            (!record(body.specification) ||
              body.specification.endpoint !== "/workflow/agents") &&
              "specification.endpoint must be /workflow/agents",
          ].filter((item): item is string => !!item);
          return { status: 200, body: { valid: errors.length === 0, errors } };
        },
      },
      runs: {
        ...notImplementedRoutes.runs,
        startRun: async ({ body, headers }) => {
          const prior = this.replay<Detail>(
            "/api/v1/runs",
            headers["idempotency-key"],
            body,
          );
          if (prior) return prior;
          if (body.projectId || body.engineOptions)
            return invalid("Projects and engine options are not supported");
          if (
            body.target?.kind === "workflow" &&
            body.target.workflowId !== workflow.id
          )
            return missing("Workflow");
          if (body.target?.kind === "agent" && !agent(body.target.agentId))
            return invalid("Unknown agent");
          if (!body.target) return invalid("A target is required");
          const isWorkflow = body.target.kind === "workflow";
          const agentId =
            body.target.kind === "agent"
              ? (body.target.agentId as Agent)
              : undefined;
          if (
            !record(body.input) ||
            !text(body.input.text) ||
            Object.keys(body.input).some(
              (key) =>
                !["text", ...(isWorkflow ? ["conversationIds"] : [])].includes(
                  key,
                ),
            )
          )
            return invalid("Invalid text input");
          if (isWorkflow && body.conversationId)
            return invalid("Workflow conversationId is not supported");
          const selected = isWorkflow ? body.input.conversationIds : undefined;
          if (
            selected !== undefined &&
            (!record(selected) ||
              Object.keys(selected).some((key) => !agent(key)) ||
              Object.values(selected).some((id) => !text(id)))
          )
            return invalid("Invalid conversationIds");
          const chosen = selected as Record<string, string> | undefined;
          const writer = isWorkflow
            ? chosen?.writer
            : agentId === "writer"
              ? body.conversationId
              : undefined;
          const reviewer = isWorkflow
            ? chosen?.reviewer
            : agentId === "reviewer"
              ? body.conversationId
              : undefined;
          if (
            (writer && !this.ownership(writer, "writer")) ||
            (reviewer && !this.ownership(reviewer, "reviewer")) ||
            (writer && reviewer && writer === reviewer)
          )
            return invalid(
              "Conversation does not belong to the selected agent",
            );
          if (
            this.checkBusy(
              [writer, reviewer].filter((id): id is string => !!id),
            )
          )
            return problem(
              409,
              "conversation_busy",
              "Conversation is unavailable for execution",
            );
          const actualWriter =
            isWorkflow || agentId === "writer"
              ? (writer ?? this.create("writer").id)
              : undefined;
          const actualReviewer =
            isWorkflow || agentId === "reviewer"
              ? (reviewer ?? this.create("reviewer").id)
              : undefined;
          const ids = [actualWriter, actualReviewer].filter(
            (id): id is string => !!id,
          );
          ids.forEach((id) => this.busy.add(id));
          const links = ids.map((id) => ({
            conversationId: id,
            nodeId:
              this.conversations.get(id)!.agentId === "writer"
                ? "writer-node"
                : "reviewer-node",
          }));
          const detail = this.accept(
            body.target,
            body.input,
            links,
            isWorkflow ? undefined : ids[0],
          );
          this.add(
            actualWriter ?? actualReviewer!,
            "user",
            body.input.text,
            detail.run.id,
          );
          const job: Job = {
            run: detail.run,
            text: body.input.text,
            writer: actualWriter,
            reviewer: actualReviewer,
            ...(!isWorkflow ? { agent: agentId } : {}),
          };
          this.jobs.set(detail.run.id, job);
          const response = structuredClone(detail);
          this.remember(
            "/api/v1/runs",
            headers["idempotency-key"],
            body,
            response,
          );
          setImmediate(() => void this.run(job));
          return { status: 202, body: response };
        },
        getRun: async ({ params }) => {
          const detail = this.runs.get(params.runId);
          return detail
            ? { status: 200, body: structuredClone(detail) }
            : missing("Run");
        },
        listRuns: async ({ query }) => {
          const items = [...this.runs.values()]
            .map(({ run }) => run)
            .filter(
              (run) =>
                (!query.projectId || run.projectId === query.projectId) &&
                (!query.targetKind || run.target?.kind === query.targetKind) &&
                (!query.status || run.status === query.status) &&
                (!query.conversationId ||
                  this.runs
                    .get(run.id)
                    ?.conversations?.some(
                      (link) => link.conversationId === query.conversationId,
                    )),
            );
          const page = this.page(items, query.cursor, query.limit);
          return page ? { status: 200, body: page } : invalid("Invalid cursor");
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
      conversations: {
        ...notImplementedRoutes.conversations,
        createConversation: async ({ body }) => {
          if (!agent(body.agentId))
            return invalid("Explicit writer or reviewer agentId required");
          if (body.projectId) return invalid("Projects are not supported");
          return { status: 201, body: this.create(body.agentId, body.title) };
        },
        getConversation: async ({ params }) => {
          const conversation = this.conversations.get(params.conversationId);
          return conversation
            ? { status: 200, body: conversation }
            : missing("Conversation");
        },
        listConversations: async ({ query }) => {
          const items = [...this.conversations.values()].filter(
            (item) =>
              (!query.agentId || item.agentId === query.agentId) &&
              (!query.projectId || item.projectId === query.projectId),
          );
          const page = this.page(items, query.cursor, query.limit);
          return page ? { status: 200, body: page } : invalid("Invalid cursor");
        },
        listMessages: async ({ params, query }) => {
          const items = this.messages.get(params.conversationId);
          if (!items) return missing("Conversation");
          const page = this.page(items, query.cursor, query.limit);
          return page ? { status: 200, body: page } : invalid("Invalid cursor");
        },
        sendMessage: async ({ params, body, headers }) => {
          const path = `/api/v1/conversations/${params.conversationId}/messages`;
          const prior = this.replay<Sent>(
            path,
            headers["idempotency-key"],
            body,
          );
          if (prior) return prior;
          const conversation = this.conversations.get(params.conversationId);
          if (!conversation) return missing("Conversation");
          if (!text(body.content))
            return problem(
              400,
              "unsupported_content",
              "Only nonblank plain text is supported",
            );
          if (this.checkBusy([conversation.id]))
            return problem(
              409,
              "conversation_busy",
              "Conversation is unavailable for execution",
            );
          const id = conversation.id;
          const owner = conversation.agentId as Agent;
          this.busy.add(id);
          const detail = this.accept(
            { kind: "agent", agentId: owner },
            body.content,
            [{ conversationId: id, nodeId: `${owner}-node` }],
            id,
          );
          const message = this.add(id, "user", body.content, detail.run.id);
          const job: Job = {
            run: detail.run,
            text: body.content,
            agent: owner,
            ...(owner === "writer" ? { writer: id } : { reviewer: id }),
          };
          this.jobs.set(detail.run.id, job);
          const response = {
            message: structuredClone(message),
            run: structuredClone(detail.run),
          };
          this.remember(path, headers["idempotency-key"], body, response);
          setImmediate(() => void this.run(job));
          return { status: 202, body: response };
        },
      },
    };
  }
}
