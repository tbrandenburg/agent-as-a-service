import { z } from "zod";
import { id, timestamp } from "./common.js";

export const project = z.object({
  id,
  name: z.string(),
  repositoryUrl: z.string().url().nullable().optional(),
  localPath: z.string().min(1).optional(),
  createdAt: timestamp,
});
export const contentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
  z.object({
    type: z.literal("file"),
    name: z.string().min(1),
    mediaType: z.string().min(1).optional(),
    contentBase64: z.string().min(1),
  }),
  z.object({ type: z.literal("data"), data: z.record(z.unknown()) }),
]);
export const conversation = z.object({
  id,
  projectId: id.nullish(),
  agentId: id.nullish(),
  title: z.string().min(1),
  createdAt: timestamp,
});
export const message = z.object({
  id,
  conversationId: id,
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string().min(1), z.array(contentPart).min(1)]),
  createdAt: timestamp,
  runId: id.nullish(),
});
/** SSE data payload; sequence and Last-Event-ID are scoped to one conversation. */
export const conversationEvent = z.object({
  id,
  conversationId: id,
  sequence: z.number().int().min(1),
  type: z.string().min(1),
  runId: id.nullish(),
  data: z.record(z.unknown()).optional(),
  createdAt: timestamp,
});
export const sendMessageInput = z.object({
  content: z.union([z.string().min(1), z.array(contentPart).min(1)]),
});

export const definitionInput = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  engine: z.string().min(1).optional(),
  specificationVersion: z.string().min(1).optional(),
  specification: z.union([z.string().min(1), z.record(z.unknown())]),
});
export const definition = definitionInput.extend({
  id,
  name: z.string().min(1),
  projectId: id.nullish(),
  readOnly: z.boolean().optional(),
  version: z.number().int().min(1),
  createdAt: timestamp,
});
export const validation = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
});

export const runStatus = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);
export const runInput = z.union([
  z.string().min(1),
  z.record(z.unknown()),
  z.array(contentPart).min(1),
]);
export const runTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: id }),
  z.object({ kind: z.literal("workflow"), workflowId: id }),
]);
export const run = z.object({
  id,
  projectId: id.nullish(),
  target: runTarget.optional(),
  workflowVersion: z.number().int().min(1).nullish(),
  conversationId: id.nullish(),
  status: runStatus,
  input: runInput.optional(),
  output: z.union([z.string(), z.array(contentPart)]).nullish(),
  error: z
    .object({ code: z.string().min(1), message: z.string().min(1) })
    .nullish(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const execution = z.object({
  id,
  runId: id,
  key: z.string().nullish(),
  status: z.enum([
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "skipped",
    "cancelled",
  ]),
  output: z.unknown().optional(),
});
export const interaction = z.object({
  id,
  runId: id,
  executionId: id.nullish(),
  prompt: z.string(),
  decisions: z.array(z.string()).optional(),
  status: z.enum(["pending", "decided"]),
  decision: z.string().nullish(),
  comment: z.string().nullish(),
  artifactIds: z.array(id).optional(),
});
export const runDetail = z.object({
  run,
  executions: z.array(execution).optional(),
  interactions: z.array(interaction).optional(),
});
export const event = z.object({
  id,
  runId: id,
  sequence: z.number().int().min(1),
  type: z.string(),
  executionId: id.nullish(),
  data: z.record(z.unknown()).optional(),
  createdAt: timestamp,
});
/** Portable SSE payloads; unknown event types remain valid for backend extensions. */
export const messageDeltaEvent = conversationEvent.extend({
  type: z.literal("message.delta"),
  data: z.object({ messageId: id, text: z.string().min(1) }),
});
export const messageCreatedEvent = conversationEvent.extend({
  type: z.literal("message.created"),
  data: z.object({ message }),
});
export const conversationRunUpdatedEvent = conversationEvent.extend({
  type: z.literal("run.updated"),
  runId: id,
  data: z.object({ run }),
});
export const runUpdatedEvent = event.extend({
  type: z.literal("run.updated"),
  data: z.object({ status: runStatus }),
});
export const artifact = z.object({
  id,
  runId: id,
  executionId: id.nullish(),
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int().min(0),
  createdAt: timestamp,
});
export const artifactContent = z.object({
  artifact,
  contentBase64: z.string(),
});
export const runStart = z
  .object({
    projectId: id.optional(),
    input: runInput.optional(),
    target: runTarget.optional(),
    conversationId: id.optional(),
    engineOptions: z.record(z.unknown()).optional(),
  })
  .strict();
export const sentMessage = z.object({
  message: message.extend({ runId: id }),
  run,
});
export const runAction = z.object({ run });
