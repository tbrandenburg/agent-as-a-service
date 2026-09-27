import { initContract } from "@ts-rest/core";
import { z } from "zod";
import * as c from "./schemas/common.js";
import * as d from "./schemas/domain.js";

const t = initContract();
export const interactions = t.router({
  listPendingInteractions: {
    method: "GET",
    path: "/api/v1/interactions",
    query: c.pagination.extend({ projectId: c.id.optional() }),
    responses: { 200: c.page(d.interaction), ...c.errors },
    summary: "List pending human approvals and feedback requests",
  },
  submitInteractionDecision: {
    method: "POST",
    path: "/api/v1/interactions/:interactionId/decisions",
    pathParams: z.object({ interactionId: c.id }),
    headers: z.object({
      "idempotency-key": z.string().min(8).max(128).optional(),
    }),
    body: z.object({
      decision: z.string().min(1),
      comment: z.string().optional(),
    }),
    responses: { 200: d.runAction, ...c.errors },
    summary:
      "Approve, reject or give a declared response; continue the run when possible",
    description: c.idempotencyDescription,
  },
});
