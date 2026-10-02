import { initContract } from "@ts-rest/core";
import { z } from "zod";
import * as c from "./schemas/common.js";
import * as d from "./schemas/domain.js";
const t = initContract();
const q = c.pathConversation;
export const conversations = t.router({
  listConversations: {
    method: "GET",
    path: "/api/v1/conversations",
    query: c.pagination.extend({
      projectId: c.id.optional(),
      targetKind: d.targetRef.shape.kind.optional(),
      targetId: c.id.optional(),
    }),
    responses: { 200: c.page(d.conversation), ...c.errors },
    summary: "List conversations",
    description:
      "Filter by targetKind or targetId independently; when both are supplied, both must match.",
  },
  createConversation: {
    method: "POST",
    path: "/api/v1/conversations",
    body: z.object({
      title: z.string().min(1).optional(),
      target: d.targetRef.optional(),
      projectId: c.id.optional(),
    }),
    responses: { 201: d.conversation, ...c.errors },
    summary:
      "Create a conversation with an explicit or server-default conversation target",
    description:
      "The target identifies the logical owner, origin or default target. It may be omitted or null on observed conversations. Continuing a conversation does not imply rerunning its target; a backend may continue an established provider session directly.",
  },
  getConversation: {
    method: "GET",
    path: "/api/v1/conversations/:conversationId",
    pathParams: q,
    responses: { 200: d.conversation, ...c.errors },
    summary: "Get a conversation",
  },
  updateConversation: {
    method: "PATCH",
    path: "/api/v1/conversations/:conversationId",
    pathParams: q,
    body: z.object({ title: z.string().min(1) }),
    responses: { 200: d.conversation, ...c.errors },
    summary: "Rename a conversation",
  },
  deleteConversation: {
    method: "DELETE",
    path: "/api/v1/conversations/:conversationId",
    pathParams: q,
    responses: { 200: c.success, ...c.errors },
    summary: "Soft-delete a conversation",
  },
  listMessages: {
    method: "GET",
    path: "/api/v1/conversations/:conversationId/messages",
    pathParams: q,
    query: c.pagination,
    responses: { 200: c.page(d.message), ...c.errors },
    summary: "List conversation messages",
  },
  sendMessage: {
    method: "POST",
    path: "/api/v1/conversations/:conversationId/messages",
    pathParams: q,
    headers: z.object({
      "idempotency-key": z.string().min(8).max(128).optional(),
    }),
    body: d.sendMessageInput,
    responses: { 202: d.sentMessage, ...c.errors, ...c.payloadTooLarge },
    summary: "Send a conversation message and start a tracked run",
    description: `On 202, the returned run is immediately readable through getRun. Acceptance does not promise agent completion within a fixed time. Oversized inline file content returns 413 payload_too_large. ${c.idempotencyDescription}`,
  },
  streamConversationEvents: {
    method: "GET",
    path: "/api/v1/conversations/:conversationId/events/stream",
    pathParams: q,
    headers: z.object({
      "last-event-id": z.string().regex(/^\d+$/).optional(),
    }),
    responses: {
      200: t.otherResponse({
        contentType: "text/event-stream",
        body: z.string(),
      }),
      ...c.errors,
    },
    summary: "Stream conversation events with resumable SSE sequence IDs",
    description:
      "SSE id is the conversation-scoped decimal sequence; data is a conversationEvent JSON object. Standard types: message.delta carries {messageId,text} for incremental text; message.created carries {message} for a complete persisted message; run.updated carries {run}. Unknown types may be ignored. Last-Event-ID replays retained later events before live delivery. If complete replay is unavailable, return 409 event_history_unavailable before opening the stream. Without a cursor, follow new events.",
  },
});
