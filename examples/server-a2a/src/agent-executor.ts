import { randomUUID } from "node:crypto";
import type {
  AgentExecutor as Executor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";
import { Role, TaskState } from "@a2a-js/sdk";
import { Backend, BackendError, type Run } from "./backend.js";
import { CommandError, parseCommand } from "./commands.js";

type ActiveTask = {
  runId: string;
  contextId: string;
  bus: ExecutionEventBus;
  cancelled: boolean;
  terminal: boolean;
  cancelPromise?: Promise<void>;
};

export class ManagementExecutor implements Executor {
  private readonly active = new Map<string, ActiveTask>();

  constructor(
    private readonly backend: Backend,
    private readonly pollMs = 250,
    private readonly pollLimit = 240,
  ) {}

  async execute(
    context: RequestContext,
    bus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    try {
      const command = parseCommand(userMessage.parts);
      if (command === "text-list" || command.operation === "workflows.list") {
        const items = await this.backend.listWorkflows();
        bus.publish(
          AgentEvent.message({
            messageId: randomUUID(),
            contextId,
            taskId: "",
            role: Role.ROLE_AGENT,
            parts: [
              {
                content: { $case: "data", value: { workflows: items } },
                mediaType: "application/json",
                metadata: undefined,
                filename: "",
              },
            ],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          }),
        );
        return;
      }
      const run = await this.backend.startRun(
        command.parameters.workflowId,
        command.parameters.input,
      );
      const task = {
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [userMessage],
        metadata: undefined,
      };
      const active = {
        runId: run.id,
        contextId,
        bus,
        cancelled: false,
        terminal: false,
      };
      this.active.set(taskId, active);
      bus.publish(AgentEvent.task(task));
      void this.poll(taskId, contextId, active, run);
    } catch (error) {
      bus.publish(
        AgentEvent.message({
          messageId: randomUUID(),
          contextId,
          taskId: "",
          role: Role.ROLE_AGENT,
          parts: [
            {
              content: {
                $case: "text",
                value:
                  error instanceof CommandError || error instanceof BackendError
                    ? error.message
                    : "Management operation failed",
              },
              mediaType: "text/plain",
              metadata: undefined,
              filename: "",
            },
          ],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        }),
      );
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) return;
    active.cancelPromise ??= (async () => {
      const run = await this.backend.cancelRun(active.runId);
      if (run.status !== "cancelled")
        throw new Error("Backend did not confirm cancellation");
      active.cancelled = true;
      if (!active.terminal) {
        active.terminal = true;
        bus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId: active.contextId,
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          }),
        );
      }
      this.active.delete(taskId);
    })();
    const cancellation = active.cancelPromise;
    try {
      await cancellation;
    } catch (error) {
      if (active.cancelPromise === cancellation)
        active.cancelPromise = undefined;
      throw error;
    }
  }

  private async poll(
    taskId: string,
    contextId: string,
    active: ActiveTask,
    initial: Run,
  ): Promise<void> {
    let run = initial;
    for (
      let count = 0;
      count < this.pollLimit && !active.cancelled && !active.terminal;
      count += 1
    ) {
      if (
        ["completed", "failed", "cancelled", "rejected", "paused"].includes(
          run.status,
        )
      ) {
        if (active.terminal) return;
        active.terminal = true;
        if (run.status === "completed") {
          active.bus.publish(
            AgentEvent.artifactUpdate({
              taskId,
              contextId,
              artifact: {
                artifactId: randomUUID(),
                name: "Workflow output",
                description: "",
                parts: [
                  {
                    content: { $case: "data", value: run.output },
                    mediaType: "application/json",
                    metadata: undefined,
                    filename: "",
                  },
                ],
                metadata: undefined,
                extensions: [],
              },
              append: false,
              lastChunk: true,
              metadata: undefined,
            }),
          );
        }
        const state =
          run.status === "completed"
            ? TaskState.TASK_STATE_COMPLETED
            : run.status === "cancelled"
              ? TaskState.TASK_STATE_CANCELED
              : TaskState.TASK_STATE_FAILED;
        active.bus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state,
              timestamp: new Date().toISOString(),
              ...(run.error
                ? {
                    message: {
                      messageId: randomUUID(),
                      contextId,
                      taskId,
                      role: Role.ROLE_AGENT,
                      parts: [
                        {
                          content: {
                            $case: "text",
                            value: run.error?.code
                              ? `Workflow execution failed (${run.error.code})`
                              : "Workflow execution failed",
                          },
                          mediaType: "text/plain",
                          metadata: undefined,
                          filename: "",
                        },
                      ],
                      metadata: undefined,
                      extensions: [],
                      referenceTaskIds: [],
                    },
                  }
                : { message: undefined }),
            },
            metadata: undefined,
          }),
        );
        this.active.delete(taskId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      try {
        run = await this.backend.getRun(active.runId);
      } catch {
        // A failed read does not prove the backend Run stopped. Retry within
        // the existing poll bound and keep the Task available for cancellation.
        continue;
      }
    }
  }
}
