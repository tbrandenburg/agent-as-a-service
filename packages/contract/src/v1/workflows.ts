import { initContract } from "@ts-rest/core";
import { z } from "zod";
import * as c from "./schemas/common.js";
import * as d from "./schemas/domain.js";
const t = initContract();
const def = z.object({ workflowId: c.id });
export const workflows = t.router({
  validateWorkflow: {
    method: "POST",
    path: "/api/v1/workflows/validate",
    body: d.definitionInput.extend({ projectId: c.id.optional() }),
    responses: { 200: d.validation, ...c.errors },
    summary: "Validate a workflow definition without saving",
  },
  listWorkflows: {
    method: "GET",
    path: "/api/v1/workflows",
    query: c.pagination.extend({ projectId: c.id.optional() }),
    responses: { 200: c.page(d.definition), ...c.errors },
    summary: "List saved and server-provided workflow definitions",
  },
  createWorkflow: {
    method: "POST",
    path: "/api/v1/workflows",
    body: d.definitionInput.extend({ projectId: c.id.optional() }),
    responses: { 201: d.definition, ...c.errors },
    summary: "Create a versioned workflow definition",
    metadata: { responseEtag: true },
    description:
      'Success returns ETag: "v{version}" for use with If-Match on updateWorkflow.',
  },
  getWorkflow: {
    method: "GET",
    path: "/api/v1/workflows/:workflowId",
    pathParams: def,
    responses: { 200: d.definition, ...c.errors },
    summary: "Get a workflow definition",
    metadata: { responseEtag: true },
    description:
      'Success returns ETag: "v{version}" for use with If-Match on updateWorkflow.',
  },
  updateWorkflow: {
    method: "PUT",
    path: "/api/v1/workflows/:workflowId",
    pathParams: def,
    headers: z.object({
      "if-match": z
        .string()
        .regex(/^"v[1-9]\d*"$/)
        .optional(),
    }),
    body: d.definitionInput,
    responses: { 200: d.definition, ...c.errors, ...c.preconditionFailed },
    summary: "Update a workflow definition at a known version",
    metadata: { responseEtag: true },
    description:
      'When supplied, If-Match must equal the current strong ETag ("v{version}"). A mismatch returns 412 precondition_failed without updating. Success increments version and returns the new ETag. Without If-Match, the update is unconditional.',
  },
  deleteWorkflow: {
    method: "DELETE",
    path: "/api/v1/workflows/:workflowId",
    pathParams: def,
    responses: { 200: c.success, ...c.errors },
    summary: "Delete a writable workflow definition",
  },
});
