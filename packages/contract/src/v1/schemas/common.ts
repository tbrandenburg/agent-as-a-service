import { z } from "zod";

// Opaque IDs let a small server use local keys such as "default".
export const id = z.string().min(1);
export const timestamp = z.string().datetime();
export const error = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export const errors = {
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
  429: error,
  500: error,
  501: error,
  503: error,
} as const;
export const preconditionFailed = { 412: error } as const;
export const payloadTooLarge = { 413: error } as const;
export const publicSystemErrors = { 500: error, 503: error } as const;
export const statusErrors = {
  401: error,
  403: error,
  500: error,
  503: error,
} as const;
/** Same principal + method + resolved path + key identifies one request for at least 24 hours. */
export const idempotencyDescription =
  "Idempotency-Key is scoped to the authenticated principal, HTTP method and resolved path. For at least 24 hours after acceptance, retries with the same key and identical body return the same status and body without repeating side effects. A different body for that key returns 409 idempotency_conflict. Concurrent retries cannot start duplicate work.";
export const pagination = z.object({
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: id.nullable() });
export const success = z.object({ success: z.boolean() });
export const pathProject = z.object({ projectId: id });
export const pathConversation = z.object({ conversationId: id });
export const pathRun = z.object({ runId: id });
