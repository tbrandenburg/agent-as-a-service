import { initContract } from "@ts-rest/core";
import { z } from "zod";
import * as c from "./schemas/common.js";
import * as d from "./schemas/domain.js";
const t = initContract();
const run = c.pathRun;
export const runs = t.router({
  listRuns: {
    method: "GET",
    path: "/api/v1/runs",
    query: c.pagination.extend({
      projectId: c.id.optional(),
      targetKind: z.enum(["agent", "workflow"]).optional(),
      status: d.runStatus.optional(),
      conversationId: c.id.optional(),
    }),
    responses: { 200: c.page(d.run), ...c.errors },
    summary: "List agent and workflow runs",
  },
  startRun: {
    method: "POST",
    path: "/api/v1/runs",
    headers: z.object({
      "idempotency-key": z.string().min(8).max(128).optional(),
    }),
    body: d.runStart,
    responses: { 202: d.runDetail, ...c.errors, ...c.payloadTooLarge },
    summary: "Start an agent or workflow run",
    description: `On 202, the returned run is immediately readable through getRun. Acceptance does not promise execution completion within a fixed time. Oversized inline file content returns 413 payload_too_large. ${c.idempotencyDescription}`,
  },
  getRun: {
    method: "GET",
    path: "/api/v1/runs/:runId",
    pathParams: run,
    responses: { 200: d.runDetail, ...c.errors },
    summary: "Inspect an agent or workflow run, executions and interactions",
  },
  cancelRun: {
    method: "POST",
    path: "/api/v1/runs/:runId/cancel",
    pathParams: run,
    body: z.object({ reason: z.string().optional() }).optional(),
    responses: { 200: d.runAction, ...c.errors },
    summary: "Cancel an active run",
  },
  resumeRun: {
    method: "POST",
    path: "/api/v1/runs/:runId/resume",
    pathParams: run,
    body: t.noBody(),
    responses: { 200: d.runAction, ...c.errors },
    summary: "Resume a resumable run",
  },
  deleteRun: {
    method: "DELETE",
    path: "/api/v1/runs/:runId",
    pathParams: run,
    responses: { 200: c.success, ...c.errors },
    summary: "Delete a terminal run and its events",
  },
  listEvents: {
    method: "GET",
    path: "/api/v1/runs/:runId/events",
    pathParams: run,
    query: z.object({
      after: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(100),
    }),
    responses: { 200: z.array(d.event), ...c.errors },
    summary: "List ordered run events",
    description:
      "Returns retained run events strictly after the sequence in after. If complete replay from that sequence is unavailable, return 409 event_history_unavailable.",
  },
  streamRunEvents: {
    method: "GET",
    path: "/api/v1/runs/:runId/events/stream",
    pathParams: run,
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
    summary: "Stream run events with resumable SSE sequence IDs",
    description:
      "SSE id is the run-scoped decimal sequence; data is a RunEvent JSON object. The portable run.updated type carries {status}; unknown types may be ignored. Last-Event-ID replays retained later events before live delivery. If complete replay is unavailable, return 409 event_history_unavailable before opening the stream. Without a cursor, follow new events.",
  },
  listArtifacts: {
    method: "GET",
    path: "/api/v1/runs/:runId/artifacts",
    pathParams: run,
    responses: { 200: z.array(d.artifact), ...c.errors },
    summary: "List run artifacts",
  },
  getArtifact: {
    method: "GET",
    path: "/api/v1/runs/:runId/artifacts/:artifactId",
    pathParams: run.extend({ artifactId: c.id }),
    responses: { 200: d.artifactContent, ...c.errors },
    summary: "Read one artifact by ID",
  },
});
