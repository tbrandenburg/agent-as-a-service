import { randomUUID } from "node:crypto";
import { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";
import type { MessageChunk } from "@agent-as-a-service/agent-runtime";
import { invokeProvider } from "../../server-express/src/adapters/provider-bridge.js";
import { notImplementedRoutes } from "../../server-express/src/adapters/not-implemented.js";
import type { ApiImplementation } from "../../server-express/src/routes.js";
import { OpenCodeProvider } from "./provider.js";

type Conversation = z.infer<typeof schemas.conversation>;
type Message = z.infer<typeof schemas.message>;
type Run = z.infer<typeof schemas.run>;
type Event = z.infer<typeof schemas.event>;
type AcceptedMessage = Message & { runId: string };
type Idempotent = {
  body: string;
  result: { message: AcceptedMessage; run: Run };
  expires: number;
};

const missing = (name: string) => ({
  status: 404 as const,
  body: { error: { code: "not_found", message: `${name} was not found` } },
});
const problem = (status: 400 | 409, code: string, message: string) => ({
  status,
  body: { error: { code, message } },
});

export class OpenCodeBackend {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message[]>();
  readonly runs = new Map<string, Run>();
  readonly events = new Map<string, Event[]>();
  private readonly sessions = new Map<string, string>();
  private readonly active = new Set<string>();
  private readonly keys = new Map<string, Idempotent>();

  constructor(readonly provider: OpenCodeProvider) {}

  private event(runId: string, type: string, data: Record<string, unknown>) {
    const events = this.events.get(runId)!;
    events.push({
      id: randomUUID(),
      runId,
      sequence: events.length + 1,
      type,
      data,
      createdAt: new Date().toISOString(),
    });
  }

  private update(run: Run, status: Run["status"], patch: Partial<Run> = {}) {
    Object.assign(run, patch, { status, updatedAt: new Date().toISOString() });
    this.event(run.id, "run.updated", { status });
  }

  implementation(): ApiImplementation {
    return {
      ...notImplementedRoutes,
      conversations: {
        ...notImplementedRoutes.conversations,
        createConversation: async ({ body }) => {
          if (
            body.target &&
            (body.target.kind !== "agent" || body.target.id !== "opencode")
          )
            return problem(
              400,
              "unsupported_agent",
              "Only the opencode agent is supported",
            );
          if (body.projectId)
            return problem(
              400,
              "unsupported_project",
              "Project associations are not supported",
            );
          const conversation: Conversation = {
            id: randomUUID(),
            title: body.title ?? "Conversation",
            target: body.target ?? { kind: "agent", id: "opencode" },
            projectId: body.projectId,
            createdAt: new Date().toISOString(),
          };
          this.conversations.set(conversation.id, conversation);
          this.messages.set(conversation.id, []);
          return { status: 201, body: conversation };
        },
        getConversation: async ({ params }) => {
          const conversation = this.conversations.get(params.conversationId);
          return conversation
            ? { status: 200, body: conversation }
            : missing("Conversation");
        },
        listMessages: async ({ params, query }) => {
          const messages = this.messages.get(params.conversationId);
          if (!messages) return missing("Conversation");
          const offset = query.cursor ? Number(query.cursor) : 0;
          const start =
            Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
          const page = messages.slice(start, start + query.limit);
          return {
            status: 200,
            body: {
              items: page,
              nextCursor:
                start + query.limit < messages.length
                  ? String(start + query.limit)
                  : null,
            },
          };
        },
        sendMessage: async ({ params, body, headers }) => {
          const conversation = this.conversations.get(params.conversationId);
          if (!conversation) return missing("Conversation");
          if (typeof body.content !== "string")
            return problem(
              400,
              "unsupported_content",
              "Only plain text message content is supported",
            );
          const key = headers["idempotency-key"];
          const lookup = `${params.conversationId}\0${key ?? ""}`;
          const encoded = JSON.stringify(body);
          const prior = key ? this.keys.get(lookup) : undefined;
          if (prior && prior.expires > Date.now())
            return prior.body === encoded
              ? { status: 202, body: structuredClone(prior.result) }
              : problem(
                  409,
                  "idempotency_conflict",
                  "Key already used for another body",
                );
          if (this.active.has(conversation.id))
            return problem(
              409,
              "conversation_busy",
              "A message is already running for this conversation",
            );
          const now = new Date().toISOString();
          const run: Run = {
            id: randomUUID(),
            conversationId: conversation.id,
            target: { kind: "agent", id: "opencode" },
            status: "queued",
            input: body.content,
            createdAt: now,
            updatedAt: now,
          };
          const message: Message & { runId: string } = {
            id: randomUUID(),
            conversationId: conversation.id,
            role: "user",
            content: body.content,
            runId: run.id,
            createdAt: now,
          };
          this.runs.set(run.id, run);
          this.events.set(run.id, []);
          this.event(run.id, "run.updated", { status: "queued" });
          this.messages.get(conversation.id)!.push(message);
          this.active.add(conversation.id);
          const result: { message: Message & { runId: string }; run: Run } = {
            message: structuredClone(message),
            run: structuredClone(run),
          };
          if (key)
            this.keys.set(lookup, {
              body: encoded,
              result,
              expires: Date.now() + 86_400_000,
            });
          setImmediate(
            () => void this.execute(run, String(body.content), conversation.id),
          );
          return { status: 202, body: result };
        },
      },
      runs: {
        ...notImplementedRoutes.runs,
        getRun: async ({ params }) => {
          const run = this.runs.get(params.runId);
          return run ? { status: 200, body: { run } } : missing("Run");
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

  private async execute(run: Run, prompt: string, conversationId: string) {
    this.update(run, "running");
    try {
      const { output, sessionId, resumed } = await invokeProvider(
        this.provider,
        { prompt, resumeSessionId: this.sessions.get(conversationId) },
        (chunk: MessageChunk) => {
          if (chunk.type === "tool")
            this.event(run.id, "agent.tool", { name: chunk.toolName });
          if (chunk.type === "assistant")
            this.event(run.id, "agent.assistant", { text: chunk.content });
        },
      );
      if (!sessionId || (this.sessions.has(conversationId) && resumed !== true))
        throw new Error("opencode did not confirm session continuation");
      this.sessions.set(conversationId, sessionId);
      if (resumed !== undefined)
        this.event(run.id, "agent.session", { resumed });
      const message: Message = {
        id: randomUUID(),
        conversationId,
        role: "assistant",
        content: output,
        runId: run.id,
        createdAt: new Date().toISOString(),
      };
      this.messages.get(conversationId)!.push(message);
      this.event(run.id, "message.created", { messageId: message.id });
      this.update(run, "completed", { output });
    } catch {
      this.update(run, "failed", {
        error: {
          code: "agent_failed",
          message: "The agent could not complete this run",
        },
      });
    } finally {
      this.active.delete(conversationId);
    }
  }
}
