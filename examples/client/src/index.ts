import { initClient } from "@ts-rest/core";
import type { z } from "zod";
import { contract, schemas } from "@agent-as-a-service/contract";
export function createClient(baseUrl: string, token?: string) {
  return initClient(contract, {
    baseUrl,
    baseHeaders: token ? { authorization: `Bearer ${token}` } : {},
  });
}
export type ApiClient = ReturnType<typeof createClient>;

/** Generate a safe retry key unless the caller supplies one. */
export function sendMessage(
  api: ApiClient,
  conversationId: string,
  content: z.infer<typeof schemas.sendMessageInput>["content"],
  idempotencyKey: string = crypto.randomUUID(),
) {
  return api.conversations.sendMessage({
    params: { conversationId },
    headers: { "idempotency-key": idempotencyKey },
    body: { content },
  });
}

export function startRun(
  api: ApiClient,
  body: NonNullable<Parameters<ApiClient["runs"]["startRun"]>[0]>["body"] = {},
  idempotencyKey: string = crypto.randomUUID(),
) {
  return api.runs.startRun({
    headers: { "idempotency-key": idempotencyKey },
    body,
  });
}
