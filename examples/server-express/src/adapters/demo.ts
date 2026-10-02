import { randomUUID } from "node:crypto";
import { schemas } from "@agent-as-a-service/contract";
import type { ApiImplementation } from "../routes.js";
import { notImplementedRoutes } from "./not-implemented.js";
import { DemoStore } from "./demo-store.js";

const missing = (resource: string) => ({
  status: 404 as const,
  body: { error: { code: "not_found", message: `${resource} was not found` } },
});
const conflict = (code: string, message: string) => ({
  status: 409 as const,
  body: { error: { code, message } },
});

/** Real HTTP handlers over a small, simulated, in-memory agent. */
export function createDemoImplementation(
  store = new DemoStore(),
): ApiImplementation {
  return {
    ...notImplementedRoutes,
    projects: {
      ...notImplementedRoutes.projects,
      createProject: async ({ body }) => {
        const project = {
          id: randomUUID(),
          name: body.name ?? "Demo project",
          ...(body.repositoryUrl ? { repositoryUrl: body.repositoryUrl } : {}),
          ...(body.localPath ? { localPath: body.localPath } : {}),
          createdAt: store.timestamp(),
        };
        store.projects.set(project.id, project);
        return { status: 201, body: project };
      },
      getProject: async ({ params }) => {
        const project = store.projects.get(params.projectId);
        return project ? { status: 200, body: project } : missing("Project");
      },
      listProjects: async ({ query }) => ({
        status: 200,
        body: store.page(
          [...store.projects.values()],
          query.limit,
          query.cursor,
        ),
      }),
    },
    conversations: {
      ...notImplementedRoutes.conversations,
      createConversation: async ({ body }) => {
        if (body.projectId && !store.projects.has(body.projectId))
          return missing("Project");
        if (
          body.target &&
          (body.target.kind !== "agent" ||
            body.target.id !== store.agent.getType())
        )
          return missing("Agent");
        const conversation = {
          id: randomUUID(),
          projectId: body.projectId,
          target: body.target ?? { kind: "agent", id: store.agent.getType() },
          title: body.title ?? "Demo conversation",
          createdAt: store.timestamp(),
        };
        store.conversations.set(conversation.id, conversation);
        store.messages.set(conversation.id, []);
        return { status: 201, body: conversation };
      },
      getConversation: async ({ params }) => {
        const conversation = store.conversations.get(params.conversationId);
        return conversation
          ? { status: 200, body: conversation }
          : missing("Conversation");
      },
      listMessages: async ({ params, query }) => {
        const messages = store.messages.get(params.conversationId);
        return messages
          ? {
              status: 200,
              body: store.page(messages, query.limit, query.cursor),
            }
          : missing("Conversation");
      },
      sendMessage: async ({ params, body, headers }) => {
        const conversation = store.conversations.get(params.conversationId);
        if (!conversation) return missing("Conversation");
        const created = store.once(
          `POST /conversations/${params.conversationId}/messages`,
          headers["idempotency-key"],
          body,
          () => {
            const run = store.createRun(
              schemas.runInput.parse(body.content),
              conversation.projectId ?? undefined,
              conversation.id,
            );
            const message = {
              id: randomUUID(),
              conversationId: conversation.id,
              role: "user" as const,
              content: body.content,
              runId: run.id,
              createdAt: store.timestamp(),
            };
            store.messages.get(conversation.id)!.push(message);
            store.queueAgent(
              run.id,
              typeof body.content === "string"
                ? body.content
                : body.content
                    .map((part) =>
                      part.type === "text" ? part.text : `[${part.type}]`,
                    )
                    .join("\n"),
              conversation.id,
            );
            // Snapshot the 202 response so a retry does not reflect later run mutations.
            return {
              message: structuredClone(message),
              run: structuredClone(run),
            };
          },
        );
        return created.conflict
          ? conflict(
              "idempotency_conflict",
              "Key already used for another body",
            )
          : { status: 202, body: created.value };
      },
    },
    workflows: {
      ...notImplementedRoutes.workflows,
      listWorkflows: async ({ query }) => ({
        status: 200,
        body: store.page(
          !query.projectId || store.projects.has(query.projectId)
            ? [store.workflow]
            : [],
          query.limit,
          query.cursor,
        ),
      }),
    },
    runs: {
      ...notImplementedRoutes.runs,
      startRun: async ({ body, headers }) => {
        if (body.projectId && !store.projects.has(body.projectId))
          return missing("Project");
        const conversation = body.conversationId
          ? store.conversations.get(body.conversationId)
          : undefined;
        if (body.conversationId && !conversation)
          return missing("Conversation");
        if (
          conversation?.projectId &&
          body.projectId &&
          conversation.projectId !== body.projectId
        )
          return conflict(
            "project_mismatch",
            "Conversation belongs to a different project",
          );
        if (
          body.target?.kind === "workflow" &&
          body.target.id !== store.workflow.id
        )
          return missing("Workflow");
        if (
          body.target?.kind === "agent" &&
          body.target.id !== store.agent.getType()
        )
          return missing("Agent");
        if (body.target && !["agent", "workflow"].includes(body.target.kind))
          return {
            status: 501,
            body: {
              error: {
                code: "not_implemented",
                message: "Target kind is not supported",
              },
            },
          };
        const created = store.once(
          "POST /runs",
          headers["idempotency-key"],
          body,
          () => {
            const workflow = body.target?.kind === "workflow";
            const run = store.createRun(
              body.input,
              body.projectId ?? conversation?.projectId ?? undefined,
              body.conversationId,
              workflow,
            );
            if (workflow) store.queueReview(run.id);
            else
              store.queueAgent(
                run.id,
                typeof body.input === "string"
                  ? body.input
                  : body.input === undefined
                    ? "Hello"
                    : JSON.stringify(body.input),
                body.conversationId,
              );
            return structuredClone(store.detail(run.id));
          },
        );
        return created.conflict
          ? conflict(
              "idempotency_conflict",
              "Key already used for another body",
            )
          : { status: 202, body: created.value };
      },
      getRun: async ({ params }) =>
        store.runs.has(params.runId)
          ? { status: 200, body: store.detail(params.runId) }
          : missing("Run"),
      listRuns: async ({ query }) => ({
        status: 200,
        body: store.page(
          [...store.runs.values()].filter(
            (run) =>
              (!query.projectId || run.projectId === query.projectId) &&
              (!query.conversationId ||
                run.conversationId === query.conversationId) &&
              (!query.status || run.status === query.status) &&
              (!query.targetKind || run.target?.kind === query.targetKind),
          ),
          query.limit,
          query.cursor,
        ),
      }),
      listEvents: async ({ params, query }) => {
        const events = store.events.get(params.runId);
        return events
          ? {
              status: 200,
              body: events
                .filter((event) => event.sequence > query.after)
                .slice(0, query.limit),
            }
          : missing("Run");
      },
      listArtifacts: async ({ params }) =>
        store.runs.has(params.runId)
          ? {
              status: 200,
              body: [...store.artifacts.values()]
                .filter(({ artifact }) => artifact.runId === params.runId)
                .map(({ artifact }) => artifact),
            }
          : missing("Run"),
      getArtifact: async ({ params }) => {
        const item = store.artifacts.get(params.artifactId);
        return item?.artifact.runId === params.runId
          ? { status: 200, body: item }
          : missing("Artifact");
      },
    },
    interactions: {
      ...notImplementedRoutes.interactions,
      listPendingInteractions: async ({ query }) => ({
        status: 200,
        body: store.page(
          [...store.interactions.values()].filter(
            (item) =>
              item.status === "pending" &&
              (!query.projectId ||
                store.runs.get(item.runId)?.projectId === query.projectId),
          ),
          query.limit,
          query.cursor,
        ),
      }),
      submitInteractionDecision: async ({ params, headers, body }) => {
        const interaction = store.interactions.get(params.interactionId);
        if (!interaction) return missing("Interaction");
        const created = store.once(
          `POST /interactions/${params.interactionId}/decisions`,
          headers["idempotency-key"],
          body,
          () => {
            if (interaction.status !== "pending") return null;
            if (!interaction.decisions?.includes(body.decision))
              return "invalid" as const;
            const run = store.decide(interaction, body.decision, body.comment);
            return { run: structuredClone(run) };
          },
        );
        if (created.conflict)
          return conflict(
            "idempotency_conflict",
            "Key already used for another body",
          );
        if (!created.value)
          return conflict("already_decided", "Interaction was already decided");
        if (created.value === "invalid")
          return {
            status: 400,
            body: {
              error: {
                code: "invalid_decision",
                message: "Decision was not offered",
              },
            },
          };
        return { status: 200, body: created.value };
      },
    },
  };
}
