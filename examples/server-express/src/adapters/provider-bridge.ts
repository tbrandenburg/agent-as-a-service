import type {
  IAgentProvider,
  MessageChunk,
} from "@agent-as-a-service/agent-runtime";

/** Example translation boundary: the HTTP host chooses context and stores sessions.
 * Feed onChunk into its own persisted run/conversation event service as needed.
 */
export async function invokeProvider(
  provider: IAgentProvider,
  request: {
    prompt: string;
    localPath?: string;
    resumeSessionId?: string;
    signal?: AbortSignal;
  },
  onChunk?: (chunk: MessageChunk) => void | Promise<void>,
) {
  if (request.resumeSessionId && !provider.getCapabilities().sessionResume)
    throw new Error("Provider does not support session resume");
  let output = "";
  let result: Extract<MessageChunk, { type: "result" }> | undefined;
  for await (const chunk of provider.sendQuery(
    request.prompt,
    request.localPath,
    request.resumeSessionId,
    { signal: request.signal },
  )) {
    if (result) throw new Error("Provider emitted a chunk after its result");
    if (chunk.type === "assistant") output += chunk.content;
    if (chunk.type === "result") result = chunk;
    await onChunk?.(chunk);
  }
  if (!result) throw new Error("Provider ended without a result");
  if (result.isError)
    throw new Error(result.errors?.join("; ") ?? "Provider failed");
  return { output, sessionId: result.sessionId, resumed: result.resumed };
}
