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
      targetKind: d.targetRef.shape.kind.optional(),
      status: d.runStatus.optional(),
      conversationId: c.id.optional(),
    }),
    responses: { 200: c.page(d.run), ...c.errors },
    summary: "List runs",
  },
  startRun: {
    method: "POST",
    path: "/api/v1/runs",
    headers: z.object({
      "idempotency-key": z.string().min(8).max(128).optional(),
    }),
    body: d.runStart,
    responses: { 202: d.runDetail, ...c.errors, ...c.payloadTooLarge },
    summary: "Start a run",
    description: `Only an explicit projectId selects a run working directory; omission means projectless/global and run.projectId is null, regardless of workflow or conversation project metadata. Every workflow may run in every accessible project. conversationId requests continuity only; it does not choose cwd. A run's separate process cwd does not isolate files, and overlapping runs may access the same directory. Nodes with absolute paths or their own path bases and workflow-created worktrees require explicit paths. Backends may reject unavailable or unauthorized projects before acceptance; project removal does not erase historical run attribution. On 202, the returned run is immediately readable through getRun. Acceptance does not promise execution completion within a fixed time. Oversized inline file content returns 413 payload_too_large. ${c.idempotencyDescription}`,
  },
  getRun: {
    method: "GET",
    path: "/api/v1/runs/:runId",
    pathParams: run,
    responses: { 200: d.runDetail, ...c.errors },
    summary: "Inspect a run, executions and interactions",
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
