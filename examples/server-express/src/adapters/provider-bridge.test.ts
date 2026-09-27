import { describe, expect, it } from "vitest";
import type {
  IAgentProvider,
  MessageChunk,
} from "@agent-as-a-service/agent-runtime";
import { invokeProvider } from "./provider-bridge.js";

function provider(
  chunks: MessageChunk[],
  sessionResume = true,
): IAgentProvider {
  return {
    getType: () => "example",
    getCapabilities: () => ({ sessionResume }),
    async *sendQuery(_prompt, _cwd, resumeSessionId) {
      for (const chunk of chunks) {
        if (chunk.type === "result" && resumeSessionId)
          yield { ...chunk, resumed: true };
        else yield chunk;
      }
    },
  };
}

describe("optional agent provider bridge", () => {
  it("collects streaming text and retains provider session continuity", async () => {
    const seen: string[] = [];
    const agent = provider([
      { type: "assistant", content: "Hello " },
      { type: "tool", toolName: "search", toolCallId: "one" },
      { type: "assistant", content: "again" },
      { type: "result", sessionId: "provider-session-2", tokens: { total: 9 } },
    ]);
    const response = await invokeProvider(
      agent,
      { prompt: "Continue", resumeSessionId: "provider-session-1" },
      (chunk) => {
        seen.push(chunk.type);
      },
    );
    expect(response).toEqual({
      output: "Hello again",
      sessionId: "provider-session-2",
      resumed: true,
    });
    expect(seen).toEqual(["assistant", "tool", "assistant", "result"]);
  });

  it("rejects unsupported resume and incomplete or failed streams", async () => {
    await expect(
      invokeProvider(provider([], false), {
        prompt: "Continue",
        resumeSessionId: "old",
      }),
    ).rejects.toThrow("does not support session resume");
    await expect(
      invokeProvider(provider([]), { prompt: "Hello" }),
    ).rejects.toThrow("without a result");
    await expect(
      invokeProvider(
        provider([{ type: "result", isError: true, errors: ["offline"] }]),
        {
          prompt: "Hello",
        },
      ),
    ).rejects.toThrow("offline");
  });
});
