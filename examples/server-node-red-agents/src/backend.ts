import { randomUUID } from "node:crypto";
import { schemas } from "@agent-as-a-service/contract";
import type { z } from "zod";
import type { Store } from "./registry.js";
import { snapshot, validate } from "./native.js";
import type { Definition, Input, Registry, Specification } from "./native.js";
import { Projects, ProjectError } from "./projects.js";
import { notImplementedRoutes } from "../../server-express/src/index.js";
import type { ApiImplementation } from "../../server-express/src/index.js";

type Conversation = z.infer<typeof schemas.conversation>;
type Message = z.infer<typeof schemas.message>;
type Run = z.infer<typeof schemas.run>;
type Detail = z.infer<typeof schemas.runDetail>;
type NodeExecution = z.infer<typeof schemas.execution>;
type Event = z.infer<typeof schemas.event>;
type ConversationEvent = z.infer<typeof schemas.conversationEvent>;
type Observation = {
  version: 1;
  type:
    | "node.deployed"
    | "node.closed"
    | "execution.started"
    | "execution.terminal";
  eventId: string;
  timestamp: string;
  nodeId: string;
  deploymentId: string;
  agent: string;
  agentName: string;
  executionId?: string;
  agentObservation?: { runId: string };
  input?: { invocation: string; prompt?: string; name?: string; args?: string };
  status?: "completed" | "failed" | "timeout";
  sessionID?: string;
  resumed?: boolean;
  output?: { payload?: unknown; errorMessage?: string };
};
type Execution = {
  conversationId: string;
  nodeId: string;
  deploymentId: string;
  agent: string;
  input: string;
  terminal?: string;
  sessionID?: string;
};
type Job = {
  run: Run;
  cancelRequested: boolean;
  stopping: boolean;
  dispatched: boolean;
  cwd?: string;
  executions: Map<string, Execution>;
  failed: boolean;
  nodeSequence: number;
  nodeBatches: Map<number, string>;
  nodeExecutions: Map<string, NodeExecution>;
  nodeDrained: boolean;
};
type Result = {
  status: number;
  body: { acknowledged?: boolean; conversationId?: string; error?: string };
};
export type Executor = (payload: {
  runId: string;
  text?: string;
  input?: z.infer<typeof schemas.runInput>;
  target?: string;
  path: string;
  cwd?: string;
  flows: Record<string, unknown>[];
  sessionID?: string;
}) => Promise<void>;

export class WorkerCapacityError extends Error {}

const directFlows = (): Record<string, unknown>[] =>
  [
    { id: "direct-tab", type: "tab", label: "Direct writer" },
    {
      id: "direct-in",
      type: "http in",
      url: "/agent/writer-agent",
      method: "post",
      wires: [["direct-entry"]],
    },
    {
      id: "direct-entry",
      type: "function",
      name: "Accept direct run",
      func: `if (msg.req?.headers?.authorization !== 'Bearer '+env.get('INTERNAL_TOKEN')) { msg.statusCode=401; msg.payload={error:'Unauthorized'}; return [null,msg]; } const {runId,text,sessionID}=msg.payload||{}; if (typeof runId!=='string'||!runId||typeof text!=='string'||!text.trim()) {msg.statusCode=400;msg.payload={error:'Invalid request'};return [null,msg];} const work={runId,payload:text,agentObservation:{runId}}; if (typeof sessionID==='string'&&sessionID) work.sessionID=sessionID; msg.statusCode=202;msg.payload={accepted:true};return [work,msg];`,
      outputs: 2,
      wires: [["writer-agent"], ["direct-response"]],
    },
    {
      id: "writer-agent",
      type: "agent",
      name: "Writer",
      agent: "opencode",
      runtime: "direct",
      invocation: "prompt",
      model: "DEFAULT_MODEL",
      modelType: "env",
      prompt: "payload",
      promptType: "msg",
      auto: false,
      wires: [["direct-success"], ["direct-failure"]],
    },
    {
      id: "direct-success",
      type: "function",
      func: `if (msg.agentExecution?.status!=='completed'||typeof msg.payload!=='string'||!msg.payload.trim()) return [null,msg];msg.payload={runId:msg.runId,eventId:msg.runId+':completed',status:'completed',output:msg.payload};return [msg,null];`,
      outputs: 2,
      wires: [["direct-headers"], ["direct-failure"]],
    },
    {
      id: "direct-failure",
      type: "function",
      func: `if (!msg.runId) return null;msg.payload={runId:msg.runId,eventId:msg.runId+':failed',status:'failed'};return msg;`,
      outputs: 1,
      wires: [["direct-headers"]],
    },
    {
      id: "direct-headers",
      type: "function",
      func: `msg.method='POST';msg.url='http://api:3095/finalize';msg.headers={authorization:'Bearer '+env.get('INTERNAL_TOKEN'),'content-type':'application/json'};return msg;`,
      outputs: 1,
      wires: [["direct-request"]],
    },
    {
      id: "direct-request",
      type: "http request",
      method: "use",
      ret: "obj",
      wires: [[]],
    },
    { id: "direct-response", type: "http response", wires: [] },
  ].map((node, index) =>
    node.type === "tab"
      ? node
      : { ...node, z: "direct-tab", x: 100 + index * 80, y: 100 },
  );
const missing = (name: string) => ({
  status: 404 as const,
  body: { error: { code: "not_found", message: `${name} was not found` } },
});
const invalid = (message: string) => ({
  status: 400 as const,
  body: { error: { code: "invalid_input", message } },
});
const errorResponse = (
  status: 400 | 403 | 409 | 412 | 503,
  code: string,
  message: string,
) => ({
  status,
  body: { error: { code, message } },
});
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();
const active = (run: Run) =>
  ["queued", "running", "paused"].includes(run.status);
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    record(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const reject = (error: string, status = 409): Result => ({
  status,
  body: { error },
});

export const httpExecutor =
  (url: string, token?: string): Executor =>
  async (payload) => {
    const response = await fetch(`${url}${payload.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 202)
      throw new Error("Private dispatch was not accepted");
  };

export class AgentsBackend {
  readonly inventory = new Map<
    string,
    { deploymentId: string; agent: string; agentName: string }
  >();
  private readonly deployments = new Map<string, Set<string>>();
  private readonly closedDeployments = new Set<string>();
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message[]>();
  readonly conversationEvents = new Map<string, ConversationEvent[]>();
  readonly runs = new Map<string, Detail>();
  readonly events = new Map<string, Event[]>();
  private readonly jobs = new Map<string, Job>();
  private readonly notices = new Map<
    string,
    { body: string; result: Result }
  >();
  private readonly phases = new Map<string, { body: string; result: Result }>();
  private readonly executionOwners = new Map<string, string>();
  private readonly sessions = new Map<string, string>();
  private readonly sessionDirectories = new Map<string, string>();
  private readonly finals = new Map<string, { body: string; result: Result }>();
  private readonly keys = new Map<
    string,
    { body: string; response: Detail; expires: number }
  >();
  private registry: Registry = {};
  private mutation = Promise.resolve();

  constructor(
    private readonly dispatch: Executor,
    private readonly store?: Store,
    private readonly projects?: Projects,
    private readonly stopWorker?: (id: string) => Promise<void>,
    private readonly maxWorkers = 4,
  ) {}

  async initialize(): Promise<void> {
    await this.projects?.initialize();
    if (this.store) this.registry = await this.store.load();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work);
    this.mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private definition(id: string): Definition | undefined {
    return Object.hasOwn(this.registry, id) ? this.registry[id] : undefined;
  }

  private guard(id: string, match?: string) {
    const entry = this.definition(id);
    if (!entry) return missing("Workflow");
    if (match && match !== `"v${entry.version}"`)
      return errorResponse(
        412,
        "precondition_failed",
        "Workflow version has changed",
      );
    return null;
  }

  private async create(input: Input) {
    const errors = validate(input);
    if (errors.length) return invalid(errors.join("; "));
    const id = randomUUID();
    try {
      const definition: Definition = {
        ...structuredClone(input),
        name: input.name ?? "Workflow",
        id,
        version: 1,
        readOnly: false,
        createdAt: new Date().toISOString(),
      };
      const next = { ...this.registry, [id]: definition };
      await this.store?.save(next);
      this.registry = next;
      return { status: 201 as const, body: definition };
    } catch {
      return errorResponse(
        503,
        "registry_failed",
        "Workflow could not be committed",
      );
    }
  }

  private async replace(id: string, input: Input, match?: string) {
    const guarded = this.guard(id, match);
    if (guarded) return guarded;
    const errors = validate(input);
    if (errors.length) return invalid(errors.join("; "));
    const old = this.registry[id];
    const definition: Definition = {
      ...structuredClone(input),
      id,
      createdAt: old.createdAt,
      readOnly: false,
      name: input.name ?? old.name,
      version: old.version + 1,
    };
    try {
      const next = { ...this.registry, [id]: definition };
      await this.store?.save(next);
      this.registry = next;
    } catch {
      return errorResponse(
        503,
        "registry_failed",
        "Workflow could not be committed",
      );
    }
    return { status: 200 as const, body: definition };
  }

  private async remove(id: string) {
    const guarded = this.guard(id);
    if (guarded) return guarded;
    try {
      const next = { ...this.registry };
      delete next[id];
      await this.store?.save(next);
      this.registry = next;
      return { status: 200 as const, body: { success: true } };
    } catch {
      return errorResponse(
        503,
        "registry_failed",
        "Workflow removal could not be committed",
      );
    }
  }

  private page<T>(items: T[], cursor: string | undefined, limit: number) {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (cursor !== undefined && String(offset) !== cursor)
    )
      return null;
    return {
      items: items.slice(offset, offset + limit),
      nextCursor: offset + limit < items.length ? String(offset + limit) : null,
    };
  }

  private event(
    run: Run,
    type: string,
    data: Record<string, unknown>,
    executionId?: string,
  ) {
    const events = this.events.get(run.id)!;
    events.push({
      id: randomUUID(),
      runId: run.id,
      sequence: events.length + 1,
      type,
      data,
      executionId,
      createdAt: new Date().toISOString(),
    });
  }

  private update(run: Run, status: Run["status"], patch: Partial<Run> = {}) {
    if (!active(run)) return;
    Object.assign(run, patch, { status, updatedAt: new Date().toISOString() });
    this.event(run, "run.updated", { status });
  }

  private writable(job: Job, status?: Run["status"]) {
    return (
      this.jobs.get(job.run.id) === job &&
      active(job.run) &&
      !job.cancelRequested &&
      (!status || job.run.status === status)
    );
  }

  private async cancel(id: string, reason?: string) {
    const job = this.jobs.get(id);
    if (!job) return missing("Run");
    if (!active(job.run))
      return errorResponse(409, "run_not_active", "Run is not active");
    if (job.stopping)
      return errorResponse(
        409,
        "run_cancel_pending",
        "Run cancellation is pending",
      );
    // Claim synchronously; shutdown I/O must not hold the global mutation queue.
    job.cancelRequested = true;
    job.stopping = true;
    this.closeNodes(job);
    try {
      if (job.dispatched) {
        if (!this.stopWorker) throw new Error("Worker stop unavailable");
        await this.stopWorker(id);
      }
      this.update(job.run, "cancelled");
      this.event(
        job.run,
        "run.cancelled",
        reason === undefined ? {} : { reason },
      );
      for (const execution of job.executions.values())
        this.conversationEvent(
          execution.conversationId,
          job.run,
          "run.updated",
          {
            run: structuredClone(job.run),
          },
        );
      return { status: 200 as const, body: { run: structuredClone(job.run) } };
    } catch {
      // Retain the claim on failure: callbacks cannot disguise an uncertain stop.
      return errorResponse(
        503,
        "worker_stop_failed",
        "Execution worker could not be stopped",
      );
    } finally {
      job.stopping = false;
    }
  }

  private deleteRun(id: string) {
    const job = this.jobs.get(id);
    if (!job) return missing("Run");
    if (active(job.run))
      return errorResponse(409, "run_active", "Run is active");
    this.runs.delete(id);
    this.events.delete(id);
    this.jobs.delete(id);
    this.finals.delete(id);
    for (const execution of job.executions.keys())
      this.executionOwners.delete(execution);
    // Accepted start responses and conversation/provider state outlive the run.
    return { status: 200 as const, body: { success: true } };
  }

  /** Bounded, ordered private worker callback; a retry must replay exactly the same batch. */
  observeNodes(value: unknown): Result {
    if (
      !record(value) ||
      !text(value.runId) ||
      !Array.isArray(value.observations) ||
      value.observations.length < 1 ||
      value.observations.length > 32
    )
      return reject("Invalid node observation batch", 400);
    const job = this.jobs.get(value.runId);
    if (!job) return reject("Unknown run");
    const observations = value.observations;
    let next = job.nodeSequence;
    const pending = new Map(job.nodeExecutions);
    for (const item of observations) {
      if (
        !record(item) ||
        Object.keys(item).some(
          (key) =>
            !["sequence", "type", "nodeId", "executionId", "status"].includes(
              key,
            ),
        ) ||
        typeof item.sequence !== "number" ||
        !Number.isSafeInteger(item.sequence) ||
        item.sequence < 1 ||
        item.sequence > 4096 ||
        !text(item.nodeId) ||
        item.nodeId.length > 256 ||
        !["received", "completed", "sent"].includes(String(item.type)) ||
        (item.type !== "sent" &&
          (!text(item.executionId) || item.executionId.length > 128)) ||
        (item.type === "sent" && item.executionId !== undefined)
      )
        return reject("Invalid node observation", 400);
      const body = canonical(item);
      const sequence = item.sequence as number;
      if (sequence <= next) {
        if (job.nodeBatches.get(item.sequence as number) !== body)
          return reject("Conflicting node observation");
        continue;
      }
      if (
        job.nodeDrained ||
        !["running", "completed", "failed"].includes(job.run.status) ||
        sequence !== next + 1
      )
        return reject("Node observation out of order");
      const id = item.executionId as string;
      if (item.type === "received") {
        if (item.status !== "running" || pending.has(id))
          return reject("Invalid node receive");
        pending.set(id, {
          id,
          runId: value.runId,
          key: item.nodeId as string,
          status: "running",
        });
      } else if (item.type === "completed") {
        const execution = pending.get(id);
        if (
          !execution ||
          execution.key !== item.nodeId ||
          execution.status !== "running" ||
          !["completed", "failed"].includes(String(item.status))
        )
          return reject("Invalid node completion");
        pending.set(id, {
          ...execution,
          status: item.status as "completed" | "failed",
        });
      } else if (item.status !== undefined) return reject("Invalid node send");
      next++;
    }
    for (const item of observations)
      if (item.sequence > job.nodeSequence) {
        job.nodeBatches.set(item.sequence as number, canonical(item));
        if (item.type !== "sent")
          this.event(
            job.run,
            `node.${item.type}`,
            { nodeId: item.nodeId, status: item.status },
            item.executionId as string,
          );
        else this.event(job.run, "node.sent", { nodeId: item.nodeId });
      }
    job.nodeSequence = next;
    job.nodeExecutions = pending;
    this.runs.get(value.runId)!.executions = [...pending.values()];
    return { status: 200, body: { acknowledged: true } };
  }

  private closeNodes(job: Job, reason?: string) {
    if (job.nodeDrained) return;
    job.nodeDrained = true;
    for (const execution of job.nodeExecutions.values()) {
      if (execution.status !== "running") continue;
      execution.status = "unconfirmed";
      this.event(
        job.run,
        "node.unconfirmed",
        { nodeId: execution.key },
        execution.id,
      );
    }
    if (reason) this.event(job.run, "observation.incomplete", { reason });
  }

  drainNodes(value: unknown): Result {
    if (
      !record(value) ||
      !text(value.runId) ||
      (value.incomplete !== undefined &&
        ![
          "queue_overflow",
          "callback_failed",
          "drain_timeout",
          "ambiguous_identity",
        ].includes(String(value.incomplete)))
    )
      return reject("Invalid node drain", 400);
    const job = this.jobs.get(value.runId);
    if (!job) return reject("Unknown run");
    this.closeNodes(job, value.incomplete as string | undefined);
    return { status: 200, body: { acknowledged: true } };
  }

  private conversationEvent(
    id: string,
    run: Run,
    type: string,
    data: Record<string, unknown>,
  ) {
    const events = this.conversationEvents.get(id)!;
    events.push({
      id: randomUUID(),
      conversationId: id,
      runId: run.id,
      sequence: events.length + 1,
      type,
      data,
      createdAt: new Date().toISOString(),
    });
  }

  private add(id: string, role: Message["role"], content: string, run: Run) {
    const message: Message = {
      id: randomUUID(),
      conversationId: id,
      role,
      content,
      runId: run.id,
      createdAt: new Date().toISOString(),
    };
    this.messages.get(id)!.push(message);
    this.conversationEvent(id, run, "message.created", { message });
  }

  /** Private callback only; no observation endpoint is registered on the public API. */
  observe(value: unknown): Result {
    if (
      !record(value) ||
      value.version !== 1 ||
      !text(value.eventId) ||
      !text(value.nodeId) ||
      !text(value.deploymentId) ||
      !text(value.agent) ||
      typeof value.agentName !== "string" ||
      !text(value.timestamp) ||
      ![
        "node.deployed",
        "node.closed",
        "execution.started",
        "execution.terminal",
      ].includes(String(value.type))
    )
      return reject("Invalid observation", 400);
    const observation = value as Observation;
    const body = canonical(value);
    const prior = this.notices.get(observation.eventId);
    if (prior)
      return prior.body === body
        ? prior.result
        : reject("Conflicting event ID");
    if (
      observation.type === "node.deployed" ||
      observation.type === "node.closed"
    ) {
      const generations =
        this.deployments.get(observation.nodeId) ?? new Set<string>();
      if (
        observation.type === "node.deployed" &&
        !generations.has(observation.deploymentId)
      ) {
        generations.add(observation.deploymentId);
        this.deployments.set(observation.nodeId, generations);
        this.inventory.set(observation.nodeId, {
          deploymentId: observation.deploymentId,
          agent: observation.agent,
          agentName: observation.agentName,
        });
      }
      if (
        observation.type === "node.closed" &&
        this.inventory.get(observation.nodeId)?.deploymentId ===
          observation.deploymentId
      )
        this.inventory.delete(observation.nodeId);
      if (observation.type === "node.closed")
        this.closedDeployments.add(
          `${observation.nodeId}\0${observation.deploymentId}`,
        );
      const result = { status: 200, body: { acknowledged: true } };
      this.notices.set(observation.eventId, { body, result });
      return result;
    }
    if (
      !text(observation.executionId) ||
      !record(observation.agentObservation) ||
      !text(observation.agentObservation.runId) ||
      !record(observation.input) ||
      !text(observation.input.invocation)
    )
      return reject("Invalid execution observation", 400);
    const runId = observation.agentObservation.runId;
    const job = this.jobs.get(runId);
    const phase = `${runId}\0${observation.deploymentId}\0${observation.executionId}\0${observation.type}`;
    const existing = this.phases.get(phase);
    if (existing)
      return existing.body === body
        ? existing.result
        : reject("Conflicting execution phase");
    if (!job || !this.writable(job, "running"))
      return reject("Run is not active");
    const owner = this.executionOwners.get(observation.executionId);
    if (owner && owner !== runId)
      return reject("Execution belongs to another run");
    const execution = job.executions.get(observation.executionId);
    if (observation.type === "execution.started") {
      if (
        execution ||
        !text(observation.input.prompt ?? observation.input.args)
      )
        return reject("Invalid or duplicate execution start");
      if (
        job.run.target?.kind === "agent" &&
        observation.nodeId !== job.run.target.agentId
      )
        return reject("Unexpected agent execution");
      // A start repairs a lost best-effort deployment notice.
      if (
        this.closedDeployments.has(
          `${observation.nodeId}\0${observation.deploymentId}`,
        )
      )
        return reject("Stale deployment");
      this.inventory.set(observation.nodeId, {
        deploymentId: observation.deploymentId,
        agent: observation.agent,
        agentName: observation.agentName,
      });
      const generations =
        this.deployments.get(observation.nodeId) ?? new Set<string>();
      generations.add(observation.deploymentId);
      this.deployments.set(observation.nodeId, generations);
      const id = job.run.conversationId ?? randomUUID();
      const conversation: Conversation = {
        id,
        agentId: observation.nodeId,
        title: observation.agentName || `${observation.nodeId} conversation`,
        createdAt: new Date().toISOString(),
      };
      if (!this.conversations.has(id)) {
        this.conversations.set(id, conversation);
        this.messages.set(id, []);
        this.conversationEvents.set(id, []);
      }
      this.add(
        id,
        "user",
        (observation.input.prompt ?? observation.input.args)!,
        job.run,
      );
      job.executions.set(observation.executionId, {
        conversationId: id,
        nodeId: observation.nodeId,
        deploymentId: observation.deploymentId,
        agent: observation.agent,
        input: canonical(observation.input),
      });
      this.executionOwners.set(observation.executionId, runId);
      if (
        !this.runs
          .get(runId)!
          .conversations!.some((link) => link.conversationId === id)
      )
        this.runs.get(runId)!.conversations!.push({
          conversationId: id,
          nodeId: observation.nodeId,
        });
      this.event(
        job.run,
        "execution.started",
        { nodeId: observation.nodeId, conversationId: id },
        observation.executionId,
      );
      this.conversationEvent(id, job.run, "run.updated", {
        run: structuredClone(job.run),
      });
      const result = {
        status: 200,
        body: { acknowledged: true, conversationId: id },
      };
      this.phases.set(phase, { body, result });
      this.notices.set(observation.eventId, { body, result });
      return result;
    }
    if (
      !execution ||
      execution.nodeId !== observation.nodeId ||
      execution.deploymentId !== observation.deploymentId ||
      execution.agent !== observation.agent ||
      execution.input !== canonical(observation.input) ||
      execution.terminal ||
      !["completed", "failed", "timeout"].includes(String(observation.status))
    )
      return reject("Terminal without matching start");
    if (
      observation.status === "completed" &&
      (!record(observation.output) || !text(observation.output.payload))
    )
      return reject("Invalid successful output");
    execution.terminal = observation.status;
    if (job.run.conversationId && observation.resumed !== true)
      job.failed = true;
    if (observation.status === "completed" && text(observation.sessionID))
      this.sessions.set(execution.conversationId, observation.sessionID);
    if (observation.status === "completed" && text(observation.sessionID)) {
      const directory = this.jobs.get(runId)?.cwd;
      if (directory)
        this.sessionDirectories.set(execution.conversationId, directory);
    }
    if (observation.status === "completed")
      this.add(
        execution.conversationId,
        "assistant",
        observation.output!.payload as string,
        job.run,
      );
    else job.failed = true;
    this.event(
      job.run,
      "execution.terminal",
      {
        status: observation.status,
        nodeId: observation.nodeId,
        ...(observation.resumed !== undefined
          ? { resumed: observation.resumed }
          : {}),
      },
      observation.executionId,
    );
    this.conversationEvent(execution.conversationId, job.run, "run.updated", {
      run: structuredClone(job.run),
      executionStatus: observation.status,
    });
    const result = {
      status: 200,
      body: { acknowledged: true, conversationId: execution.conversationId },
    };
    this.phases.set(phase, { body, result });
    this.notices.set(observation.eventId, { body, result });
    return result;
  }

  /** Explicit workflow boundary, not an inference from the last observed agent. */
  finalize(value: unknown): Result {
    if (
      !record(value) ||
      !text(value.runId) ||
      !text(value.eventId) ||
      !["completed", "failed"].includes(String(value.status)) ||
      (value.status === "completed" &&
        !schemas.runOutput.safeParse(value.output).success)
    )
      return reject("Invalid finalization", 400);
    const body = canonical(value);
    const prior = this.finals.get(value.runId);
    if (prior)
      return prior.body === body
        ? prior.result
        : reject("Conflicting finalization");
    const job = this.jobs.get(value.runId);
    if (!job || !this.writable(job, "running"))
      return reject("Run is not active");
    if (
      value.status === "completed" &&
      ((job.failed && !job.run.conversationId) ||
        (job.run.target?.kind === "agent" && job.executions.size === 0) ||
        [...job.executions.values()].some(
          (execution) => execution.terminal !== "completed",
        ))
    )
      return reject("Unacknowledged execution");
    if (value.status === "completed" && job.failed)
      this.update(job.run, "failed", {
        error: {
          code: "resume_unconfirmed",
          message: "Provider did not confirm continuation",
        },
      });
    else if (value.status === "completed")
      this.update(job.run, "completed", {
        output: schemas.runOutput.parse(value.output),
      });
    else
      this.update(job.run, "failed", {
        error: {
          code: "workflow_failed",
          message: "The workflow could not complete",
        },
      });
    for (const execution of job.executions.values())
      this.conversationEvent(execution.conversationId, job.run, "run.updated", {
        run: structuredClone(job.run),
      });
    const result = { status: 200, body: { acknowledged: true } };
    this.finals.set(value.runId, { body, result });
    if (this.stopWorker)
      setImmediate(
        () =>
          void this.stopWorker!(value.runId as string).catch(() => {
            console.error("Finalized execution worker cleanup failed");
          }),
      );
    return result;
  }

  workerFailed(id: string) {
    const job = this.jobs.get(id);
    if (job && !job.nodeDrained) this.closeNodes(job, "worker_failed");
    if (job && this.writable(job))
      this.update(job.run, "failed", {
        error: { code: "worker_failed", message: "Execution worker stopped" },
      });
  }

  private projectError(error: unknown) {
    if (error instanceof ProjectError)
      return {
        status: error.status,
        body: { error: { code: error.code, message: error.message } },
      };
    return errorResponse(
      503,
      "project_failed",
      "Project storage is unavailable",
    );
  }

  private async send(
    job: Job,
    input: z.infer<typeof schemas.runInput>,
    path: string,
    cwd?: string,
    flows: Specification["flows"] = [],
    sessionID?: string,
  ) {
    if (!this.writable(job, "running")) return;
    job.dispatched = true;
    try {
      await this.dispatch({
        runId: job.run.id,
        ...(job.run.target?.kind === "agent"
          ? { text: (input as { text: string }).text }
          : { input, target: path }),
        path,
        cwd,
        flows,
        sessionID,
      });
      // A start can arrive before the dispatch response.
    } catch (error) {
      if (this.writable(job, "running"))
        this.closeNodes(job, "dispatch_failed");
      if (this.writable(job, "running"))
        this.update(job.run, "failed", {
          error: {
            code:
              error instanceof WorkerCapacityError
                ? "worker_capacity_timeout"
                : "dispatch_failed",
            message:
              error instanceof WorkerCapacityError
                ? "Execution worker capacity did not become available"
                : "The workflow could not be dispatched",
          },
        });
    }
  }

  implementation(): ApiImplementation {
    return {
      ...notImplementedRoutes,
      projects: {
        ...notImplementedRoutes.projects,
        listProjects: async ({ query }) => {
          if (!this.projects)
            return errorResponse(
              503,
              "project_unavailable",
              "Project storage unavailable",
            );
          const page = this.page(
            this.projects.list(),
            query.cursor,
            query.limit,
          );
          return page ? { status: 200, body: page } : invalid("Invalid cursor");
        },
        getProject: async ({ params }) => {
          const project = this.projects?.get(params.projectId);
          return project ? { status: 200, body: project } : missing("Project");
        },
        createProject: async ({ body }) => {
          if (!this.projects)
            return errorResponse(
              503,
              "project_unavailable",
              "Project storage unavailable",
            );
          return this.serial(async () => {
            try {
              return {
                status: 201 as const,
                body: await this.projects!.create(body),
              };
            } catch (error) {
              return this.projectError(error);
            }
          });
        },
        updateProject: async ({ params, body }) => {
          if (!this.projects)
            return errorResponse(
              503,
              "project_unavailable",
              "Project storage unavailable",
            );
          return this.serial(async () => {
            try {
              return {
                status: 200 as const,
                body: await this.projects!.rename(params.projectId, body.name),
              };
            } catch (error) {
              return this.projectError(error);
            }
          });
        },
        deleteProject: async ({ params }) => {
          if (!this.projects)
            return errorResponse(
              503,
              "project_unavailable",
              "Project storage unavailable",
            );
          return this.serial(async () => {
            if (
              [...this.jobs.values()].some(
                ({ run }) =>
                  run.projectId === params.projectId &&
                  ["queued", "running", "paused"].includes(run.status),
              )
            )
              return errorResponse(
                409,
                "project_active",
                "Project has active runs",
              );
            try {
              await this.projects!.remove(params.projectId);
              return { status: 200 as const, body: { success: true } };
            } catch (error) {
              return this.projectError(error);
            }
          });
        },
      },
      workflows: {
        ...notImplementedRoutes.workflows,
        listWorkflows: async ({ query }) => {
          const page = this.page(
            Object.values(this.registry),
            query.cursor,
            query.limit,
          );
          return page ? { status: 200, body: page } : invalid("Invalid cursor");
        },
        getWorkflow: async ({ params, res }) => {
          const definition = this.definition(params.workflowId);
          if (!definition) return missing("Workflow");
          res.setHeader("ETag", `"v${definition.version}"`);
          return { status: 200, body: definition };
        },
        validateWorkflow: async ({ body }) => {
          const errors = validate(body);
          return { status: 200, body: { valid: errors.length === 0, errors } };
        },
        createWorkflow: async ({ body, res }) => {
          const result = await this.serial(() => this.create(body));
          if (result.status === 201) res.setHeader("ETag", '"v1"');
          return result;
        },
        updateWorkflow: async ({ params, body, headers, res }) => {
          const result = await this.serial(() =>
            this.replace(params.workflowId, body, headers["if-match"]),
          );
          if (result.status === 200)
            res.setHeader("ETag", `"v${result.body.version}"`);
          return result;
        },
        deleteWorkflow: async ({ params }) =>
          this.serial(() => this.remove(params.workflowId)),
      },
      runs: {
        ...notImplementedRoutes.runs,
        cancelRun: async ({ params, body }) =>
          this.cancel(params.runId, body?.reason),
        resumeRun: async ({ params }) => {
          if (!this.runs.has(params.runId)) return missing("Run");
          // Future: paused + executor-owned opaque continuation -> runtime resume
          // of the same public run. Native workflow replay is not continuation.
          return errorResponse(
            409,
            "run_not_resumable",
            "Run has no resumable execution state",
          );
        },
        deleteRun: async ({ params }) => this.deleteRun(params.runId),
        startRun: ({ body, headers }) =>
          this.serial(async () => {
            const key = headers["idempotency-key"];
            const previous = key && this.keys.get(key);
            if (previous && previous.expires > Date.now())
              return previous.body === canonical(body)
                ? { status: 202, body: structuredClone(previous.response) }
                : {
                    status: 409,
                    body: {
                      error: {
                        code: "idempotency_conflict",
                        message: "Key already used for another body",
                      },
                    },
                  };
            if (
              body.engineOptions ||
              !body.target ||
              !schemas.runInput.safeParse(body.input).success
            )
              return invalid("A target and valid input are required");
            if (
              body.target.kind === "agent" &&
              (!record(body.input) ||
                !text(body.input.text) ||
                Object.keys(body.input).some((field) => field !== "text"))
            )
              return invalid("Only text input is supported for direct agents");
            if (
              [...this.jobs.values()].filter(({ run }) =>
                ["queued", "running", "paused"].includes(run.status),
              ).length >= this.maxWorkers
            )
              return errorResponse(
                503,
                "workers_busy",
                "Maximum concurrent execution workers reached",
              );
            if (
              body.target.kind === "agent" &&
              body.target.agentId !== "writer-agent"
            )
              return {
                status: 501 as const,
                body: {
                  error: {
                    code: "not_implemented",
                    message: "Agent target is not configured",
                  },
                },
              };
            const definition =
              body.target.kind === "workflow"
                ? this.definition(body.target.workflowId)
                : undefined;
            if (body.target.kind === "workflow" && !definition)
              return missing("Workflow");
            const prior =
              body.conversationId &&
              this.conversations.get(body.conversationId);
            if (
              body.conversationId &&
              (!prior ||
                body.target.kind !== "agent" ||
                prior.agentId !== body.target.agentId ||
                !this.sessions.has(body.conversationId))
            )
              return missing("Conversation");
            let cwd: string | undefined;
            if (this.projects) {
              try {
                cwd = await this.projects.cwd(body.projectId);
              } catch (error) {
                return this.projectError(error);
              }
            } else if (body.projectId) return missing("Project");
            if (
              body.conversationId &&
              cwd &&
              this.sessionDirectories.get(body.conversationId) !== cwd
            )
              return errorResponse(
                409,
                "conversation_directory_conflict",
                "OpenCode continuation requires the original working directory",
              );
            const accepted =
              body.target.kind === "agent"
                ? { entry: "/agent/writer-agent", flows: directFlows() }
                : snapshot(definition!);
            const now = new Date().toISOString();
            const run: Run = {
              id: randomUUID(),
              projectId: body.projectId ?? null,
              target: body.target,
              input: body.input,
              ...(definition ? { workflowVersion: definition.version } : {}),
              ...(body.conversationId
                ? { conversationId: body.conversationId }
                : {}),
              status: "queued",
              createdAt: now,
              updatedAt: now,
            };
            const detail: Detail = {
              run,
              executions: [],
              conversations: body.conversationId
                ? [
                    {
                      conversationId: body.conversationId,
                      nodeId: "writer-agent",
                    },
                  ]
                : [],
            };
            this.runs.set(run.id, detail);
            this.events.set(run.id, []);
            this.update(run, "queued");
            const job: Job = {
              run,
              cancelRequested: false,
              stopping: false,
              dispatched: false,
              cwd,
              executions: new Map(),
              failed: false,
              nodeSequence: 0,
              nodeBatches: new Map(),
              nodeExecutions: new Map(),
              nodeDrained: false,
            };
            this.jobs.set(run.id, job);
            const response = structuredClone(detail);
            if (key)
              this.keys.set(key, {
                body: canonical(body),
                response,
                expires: Date.now() + 86_400_000,
              });
            this.update(run, "running");
            const path = accepted.entry;
            const sessionID = body.conversationId
              ? this.sessions.get(body.conversationId)
              : undefined;
            setImmediate(
              () =>
                void this.send(
                  job,
                  body.input!,
                  path,
                  cwd,
                  accepted.flows,
                  sessionID,
                ),
            );
            return { status: 202, body: response };
          }),
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
        getConversation: async ({ params }) => {
          const conversation = this.conversations.get(params.conversationId);
          return conversation
            ? { status: 200, body: conversation }
            : missing("Conversation");
        },
        listConversations: async ({ query }) => {
          const page = this.page(
            [...this.conversations.values()].filter(
              (item) =>
                (!query.agentId || item.agentId === query.agentId) &&
                (!query.projectId || item.projectId === query.projectId),
            ),
            query.cursor,
            query.limit,
          );
          return page ? { status: 200, body: page } : invalid("Invalid cursor");
        },
        listMessages: async ({ params, query }) => {
          const items = this.messages.get(params.conversationId);
          if (!items) return missing("Conversation");
          const page = this.page(items, query.cursor, query.limit);
          return page ? { status: 200, body: page } : invalid("Invalid cursor");
        },
      },
    };
  }
}
