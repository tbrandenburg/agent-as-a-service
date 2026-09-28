import { describe, it, expect } from "vitest";
import {
  definitionInput,
  runDetail,
  run as runSchema,
  runStart,
  sendMessageInput,
  sentMessage,
  conversation,
  conversationEvent,
  messageDeltaEvent,
  messageCreatedEvent,
  project,
  definition,
} from "./v1/schemas/domain.js";
import { contract } from "./index.js";
describe("REST specification", () => {
  it("allows a project without a repository", () => {
    expect(
      project.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        name: "Research",
        createdAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      contract.projects.createProject.body.safeParse({ name: "Research" })
        .success,
    ).toBe(true);
    expect(contract.projects.createProject.body.safeParse({}).success).toBe(
      true,
    );
    expect(
      contract.projects.createProject.body.safeParse({
        localPath: "/work/repo",
      }).success,
    ).toBe(true);
    expect(
      contract.projects.createProject.body.safeParse({ localPath: "" }).success,
    ).toBe(false);
    expect(
      project.safeParse({
        id: "local",
        name: "Local",
        localPath: "/work/repo",
        createdAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
  });
  it("validates only the workflow envelope, leaving specifications to their engines", () => {
    expect(
      definition.safeParse({
        id: "builtin-review",
        name: "Review",
        specification: "Review this",
        version: 1,
        readOnly: true,
        createdAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
    const examples = [
      {
        name: "review",
        engine: "graph-engine",
        specificationVersion: "1",
        specification: { nodes: [{ kind: "custom", arguments: { count: 2 } }] },
      },
      {
        name: "review",
        engine: "state-machine",
        specificationVersion: "2026-01",
        specification: { states: { draft: { transitions: ["review"] } } },
      },
    ];
    for (const example of examples) {
      expect(definitionInput.parse(example).specification).toEqual(
        example.specification,
      );
    }
    expect(definitionInput.safeParse({ specification: {} }).success).toBe(true);
    expect(
      definitionInput.safeParse({ specification: "Do the review" }).success,
    ).toBe(true);
    expect(definitionInput.safeParse({}).success).toBe(false);
    expect(
      definitionInput.safeParse({
        name: "review",
        engine: "x",
        specificationVersion: "1",
        specification: [],
      }).success,
    ).toBe(false);
    const identifier = "00000000-0000-4000-8000-000000000001";
    for (const target of [
      { kind: "agent", agentId: identifier },
      { kind: "workflow", workflowId: identifier },
    ])
      expect(
        runStart.safeParse({
          target,
          input: [
            {
              type: "file",
              name: "f.txt",
              mediaType: "text/plain",
              contentBase64: "eA==",
            },
          ],
          engineOptions: { sandbox: "worktree" },
        }).success,
      ).toBe(true);
    expect(runStart.safeParse({ input: "hello" }).success).toBe(true);
    expect(runStart.safeParse({}).success).toBe(true);
    expect(runStart.safeParse({ input: "" }).success).toBe(false);
    expect(
      runStart.safeParse({ conversationId: identifier, input: "Continue" })
        .success,
    ).toBe(true);
    expect(
      runStart.safeParse({
        conversationId: identifier,
        target: { kind: "workflow", workflowId: identifier },
        input: "Start workflow",
      }).success,
    ).toBe(true);
    expect(
      runStart.safeParse({ conversationId: "", input: "Continue" }).success,
    ).toBe(false);
  });
  it("accepts engines without nodes and interactions not bound to an execution", () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    expect(
      runDetail.safeParse({
        run: {
          id: runId,
          projectId: null,
          target: { kind: "agent", agentId: runId },
          workflowVersion: null,
          conversationId: null,
          status: "paused",
          input: { prompt: "review" },
          output: null,
          error: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        executions: [],
        interactions: [
          {
            id: runId,
            runId,
            executionId: null,
            prompt: "Continue?",
            decisions: ["yes", "no"],
            status: "pending",
            decision: null,
            comment: null,
          },
        ],
      }).success,
    ).toBe(true);
  });
  it("links public conversations to a run without requiring a conversation", () => {
    const base = {
      id: "run-1",
      status: "running",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const legacy = { run: { ...base, conversationId: "primary" } };
    const withoutConversations = { run: base };
    const empty = { run: base, conversations: [] };
    const generated = {
      run: base,
      conversations: [{ conversationId: "generated", nodeId: "review" }],
    };
    const multiple = {
      run: { ...base, conversationId: "primary" },
      conversations: [
        { conversationId: "primary" },
        { conversationId: "generated", nodeId: "review" },
      ],
    };

    for (const response of [
      legacy,
      withoutConversations,
      empty,
      generated,
      multiple,
    ]) {
      expect(runDetail.safeParse(response).success).toBe(true);
      expect(
        contract.runs.getRun.responses[200].safeParse(response).success,
      ).toBe(true);
      expect(
        contract.runs.startRun.responses[202].safeParse(response).success,
      ).toBe(true);
    }
    expect(runDetail.parse(generated).conversations).toEqual(
      generated.conversations,
    );
    expect(runDetail.parse(multiple).conversations).toEqual(
      multiple.conversations,
    );
    expect(runDetail.safeParse({ ...empty, run: legacy.run }).success).toBe(
      false,
    );
    expect(
      runDetail.safeParse({
        ...multiple,
        conversations: [{ conversationId: "generated", nodeId: "review" }],
      }).success,
    ).toBe(false);
    expect(
      runDetail.safeParse({
        ...multiple,
        conversations: [
          { conversationId: "primary" },
          { conversationId: "primary" },
        ],
      }).success,
    ).toBe(false);
    expect(
      runDetail.safeParse({
        run: base,
        conversations: [{ conversationId: "" }],
      }).success,
    ).toBe(false);
    expect(
      runDetail.safeParse({
        run: base,
        conversations: [{ conversationId: "generated", nodeId: "" }],
      }).success,
    ).toBe(false);
  });
  it("provides a canonical outcome for completed and failed runs", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const base = {
      id,
      projectId: null,
      target: { kind: "agent", agentId: id },
      workflowVersion: null,
      conversationId: null,
      input: "Hello",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      runSchema.safeParse({
        ...base,
        status: "completed",
        output: [{ type: "text", text: "Hello back" }],
        error: null,
      }).success,
    ).toBe(true);
    expect(
      runSchema.safeParse({
        ...base,
        status: "failed",
        output: null,
        error: { code: "provider_unavailable", message: "Try again later" },
      }).success,
    ).toBe(true);
    expect(
      runSchema.safeParse({
        id: "run-1",
        status: "completed",
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
      }).success,
    ).toBe(true);
  });
  it("resolves a selected or default agent and links typed messages to runs", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const createBody = contract.conversations.createConversation.body;
    expect(createBody.safeParse({}).success).toBe(true);
    expect(createBody.safeParse({ title: "Default agent" }).success).toBe(true);
    expect(
      createBody.safeParse({ title: "Selected agent", agentId: id }).success,
    ).toBe(true);
    expect(
      createBody.safeParse({ title: "Invalid", agentId: "" }).success,
    ).toBe(false);
    expect(
      conversation.safeParse({
        id,
        projectId: null,
        agentId: id,
        title: "Hi",
        createdAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      sendMessageInput.safeParse({
        content: [
          { type: "text", text: "Hi" },
          { type: "data", data: { answer: 42 } },
        ],
      }).success,
    ).toBe(true);
    expect(sendMessageInput.safeParse({ content: "Hi" }).success).toBe(true);
    expect(
      sendMessageInput.safeParse({ content: [{ type: "file", name: "a" }] })
        .success,
    ).toBe(false);
    const response = {
      message: {
        id,
        conversationId: id,
        role: "user",
        content: [{ type: "text", text: "Hi" }],
        createdAt: "2026-01-01T00:00:00Z",
        runId: id,
      },
      run: {
        id,
        projectId: null,
        target: { kind: "agent", agentId: id },
        workflowVersion: null,
        conversationId: id,
        status: "queued",
        input: "Hi",
        output: null,
        error: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    expect(sentMessage.safeParse(response).success).toBe(true);
  });
  it("defines resumable conversation events without requiring a run", () => {
    const stream = contract.conversations.streamConversationEvents;
    expect(
      stream.pathParams.safeParse({ conversationId: "chat-1" }).success,
    ).toBe(true);
    expect(stream.headers.safeParse({ "last-event-id": "12" }).success).toBe(
      true,
    );
    expect(stream.headers.safeParse({ "last-event-id": "bad" }).success).toBe(
      false,
    );
    expect(
      conversationEvent.safeParse({
        id: "event-1",
        conversationId: "chat-1",
        sequence: 13,
        type: "message.created",
        data: { messageId: "message-1" },
        createdAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      messageDeltaEvent.safeParse({
        id: "event-2",
        conversationId: "chat-1",
        sequence: 14,
        type: "message.delta",
        data: { messageId: "message-1", text: "Hi" },
        createdAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      messageDeltaEvent.safeParse({
        id: "event-2",
        conversationId: "chat-1",
        sequence: 14,
        type: "message.delta",
        data: { messageId: "message-1" },
        createdAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(messageCreatedEvent.shape.type.value).toBe("message.created");
  });
  it("declares 501 for replaceable resource operations and has unique names", () => {
    const names = new Set<string>();
    let count = 0;
    const walk = (tree: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(tree)) {
        if (value && typeof value === "object" && "method" in value) {
          const route = value as unknown as {
            responses: Record<string, unknown>;
          };
          if (!(name in contract.system))
            expect(route.responses["501"], name).toBeDefined();
          expect(names.has(name), name).toBe(false);
          names.add(name);
          count++;
        } else walk(value as Record<string, unknown>);
      }
    };
    walk(contract as unknown as Record<string, unknown>);
    expect(count).toBe(33);
  });
});
