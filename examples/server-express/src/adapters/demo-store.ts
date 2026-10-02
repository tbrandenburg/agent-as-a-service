import { randomUUID } from "node:crypto";
import { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";
import type { IAgentProvider } from "@agent-as-a-service/agent-runtime";
import { DemoAgent } from "./demo-agent.js";
import { invokeProvider } from "./provider-bridge.js";

type Project = z.infer<typeof schemas.project>;
type Conversation = z.infer<typeof schemas.conversation>;
type Message = z.infer<typeof schemas.message>;
type Run = z.infer<typeof schemas.run>;
type Interaction = z.infer<typeof schemas.interaction>;
type Event = z.infer<typeof schemas.event>;
type Artifact = z.infer<typeof schemas.artifact>;
type Definition = z.infer<typeof schemas.definition>;

/** Deliberately disposable state for the walkthrough, never imported by the contract. */
export class DemoStore {
  readonly projects = new Map<string, Project>();
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message[]>();
  readonly runs = new Map<string, Run>();
  readonly interactions = new Map<string, Interaction>();
  readonly events = new Map<string, Event[]>();
  readonly artifacts = new Map<
    string,
    { artifact: Artifact; contentBase64: string }
  >();
  readonly agent: IAgentProvider;
  private readonly conversationSessions = new Map<string, string>();
  constructor(agent: IAgentProvider = new DemoAgent()) {
    this.agent = agent;
  }
  readonly workflow: Definition = {
    id: "review-demo",
    name: "Review change",
    description: "Simulate a review that waits for a human decision",
    specification: { kind: "demo-review" },
    version: 1,
    readOnly: true,
    createdAt: new Date().toISOString(),
  };
  private readonly keys = new Map<
    string,
    { body: string; response: unknown; created: number }
  >();

  timestamp() {
    return new Date().toISOString();
  }

  page<T>(items: T[], limit: number, cursor?: string) {
    const offset = cursor ? Number(cursor) : 0;
    const index = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const next = index + limit;
    return {
      items: items.slice(index, next),
      nextCursor: next < items.length ? String(next) : null,
    };
  }

  /** Accepted requests replay their original response; changed bodies conflict. */
  once<T>(
    scope: string,
    key: string | undefined,
    body: unknown,
    action: () => T,
  ): { value: T; conflict: false } | { conflict: true } {
    if (!key) return { value: action(), conflict: false };
    const lookup = `${scope}\u0000${key}`;
    const encoded = JSON.stringify(body);
    const prior = this.keys.get(lookup);
    if (prior && Date.now() - prior.created < 86_400_000) {
      if (prior.body !== encoded) return { conflict: true };
      return { value: prior.response as T, conflict: false };
    }
    const value = action();
    // An invalid or already-decided request was never accepted for replay.
    if (value !== null && value !== "invalid")
      this.keys.set(lookup, {
        body: encoded,
        response: value,
        created: Date.now(),
      });
    return { value, conflict: false };
  }

  createRun(
    input: Run["input"],
    projectId?: string,
    conversationId?: string,
    workflow = false,
  ): Run {
    const now = this.timestamp();
    const run: Run = {
      id: randomUUID(),
      projectId,
      conversationId,
      target: workflow
        ? { kind: "workflow", id: this.workflow.id }
        : { kind: "agent", id: this.agent.getType() },
      ...(workflow ? { workflowVersion: this.workflow.version } : {}),
      status: "queued",
      input,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    this.event(run.id, "run.updated", { status: "queued" });
    return run;
  }

  event(runId: string, type: string, data: Record<string, unknown>) {
    const events = this.events.get(runId)!;
    events.push({
      id: randomUUID(),
      runId,
      sequence: events.length + 1,
      type,
      data,
      createdAt: this.timestamp(),
    });
  }

  updateRun(runId: string, patch: Partial<Run>) {
    const run = this.runs.get(runId)!;
    Object.assign(run, patch, { updatedAt: this.timestamp() });
    this.event(runId, "run.updated", { status: run.status });
    return run;
  }

  detail(runId: string) {
    const run = this.runs.get(runId)!;
    return {
      run,
      ...(run.conversationId && this.conversations.has(run.conversationId)
        ? { conversations: [{ conversationId: run.conversationId }] }
        : {}),
      interactions: [...this.interactions.values()].filter(
        (item) => item.runId === runId,
      ),
    };
  }

  queueAgent(runId: string, prompt: string, conversationId?: string) {
    setTimeout(() => {
      void this.executeAgent(runId, prompt, conversationId);
    }, 50);
  }

  private async executeAgent(
    runId: string,
    prompt: string,
    conversationId?: string,
  ) {
    if (this.runs.get(runId)?.status !== "queued") return;
    this.updateRun(runId, { status: "running" });
    const projectId = this.runs.get(runId)?.projectId;
    const localPath = projectId
      ? this.projects.get(projectId)?.localPath
      : undefined;
    try {
      const { output, sessionId, resumed } = await invokeProvider(
        this.agent,
        {
          prompt,
          localPath,
          resumeSessionId: conversationId
            ? this.conversationSessions.get(conversationId)
            : undefined,
        },
        (chunk) => {
          if (chunk.type === "assistant")
            this.event(runId, "agent.assistant", { text: chunk.content });
          if (chunk.type === "tool")
            this.event(runId, "agent.tool", { name: chunk.toolName });
        },
      );
      if (conversationId && sessionId)
        this.conversationSessions.set(conversationId, sessionId);
      if (conversationId) {
        const message: Message = {
          id: randomUUID(),
          conversationId,
          role: "assistant",
          content: output,
          runId,
          createdAt: this.timestamp(),
        };
        this.messages.get(conversationId)!.push(message);
        this.event(runId, "message.created", { messageId: message.id });
      }
      if (resumed !== undefined)
        this.event(runId, "agent.session", { resumed });
      this.updateRun(runId, { status: "completed", output });
    } catch (error) {
      this.updateRun(runId, {
        status: "failed",
        error: {
          code: "agent_failed",
          message: error instanceof Error ? error.message : "Agent failed",
        },
      });
    }
  }

  queueReview(runId: string) {
    setTimeout(() => {
      if (this.runs.get(runId)?.status !== "queued") return;
      this.updateRun(runId, { status: "running" });
      const interaction: Interaction = {
        id: randomUUID(),
        runId,
        prompt: "Approve the proposed change?",
        decisions: ["approve", "reject"],
        status: "pending",
      };
      this.interactions.set(interaction.id, interaction);
      this.updateRun(runId, { status: "paused" });
      this.event(runId, "interaction.created", {
        interactionId: interaction.id,
      });
    }, 80);
  }

  decide(interaction: Interaction, decision: string, comment?: string) {
    Object.assign(interaction, { status: "decided", decision, comment });
    this.event(interaction.runId, "interaction.decided", {
      interactionId: interaction.id,
      decision,
    });
    if (decision === "reject")
      return this.updateRun(interaction.runId, { status: "rejected" });
    const run = this.updateRun(interaction.runId, { status: "running" });
    setTimeout(() => {
      if (this.runs.get(run.id)?.status !== "running") return;
      const content =
        "# Review result\n\nThe proposed change passed the simulated review.\n";
      const artifact: Artifact = {
        id: randomUUID(),
        runId: run.id,
        name: "review.md",
        mediaType: "text/markdown",
        sizeBytes: Buffer.byteLength(content),
        createdAt: this.timestamp(),
      };
      this.artifacts.set(artifact.id, {
        artifact,
        contentBase64: Buffer.from(content).toString("base64"),
      });
      this.event(run.id, "artifact.created", { artifactId: artifact.id });
      this.updateRun(run.id, {
        status: "completed",
        output: "Review approved; report ready.",
      });
    }, 80);
    return run;
  }
}
