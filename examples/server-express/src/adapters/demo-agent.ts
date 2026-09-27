import { randomUUID } from "node:crypto";
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
} from "@agent-as-a-service/agent-runtime";

/** Simulated provider with genuine stream and session semantics; no AI API calls. */
export class DemoAgent implements IAgentProvider {
  private readonly sessions = new Map<string, number>();

  getType() {
    return "assistant-demo";
  }

  getCapabilities(): ProviderCapabilities {
    return { sessionResume: true, tokenReporting: true };
  }

  async *sendQuery(
    prompt: string,
    _cwd?: string,
    resumeSessionId?: string,
  ): AsyncGenerator<MessageChunk> {
    const previousTurns = resumeSessionId
      ? this.sessions.get(resumeSessionId)
      : undefined;
    const resumed = resumeSessionId ? previousTurns !== undefined : undefined;
    const response = resumed
      ? "Continuing our conversation. I can help with the next step."
      : /review/i.test(prompt)
        ? "I can help with that change. Start the Review change workflow when you are ready."
        : "Simulated agent response.";
    const middle = Math.ceil(response.length / 2);
    yield { type: "assistant", content: response.slice(0, middle) };
    yield { type: "assistant", content: response.slice(middle) };
    const sessionId = randomUUID();
    this.sessions.set(sessionId, (previousTurns ?? 0) + 1);
    yield {
      type: "result",
      sessionId,
      ...(resumed === undefined ? {} : { resumed }),
      tokens: { total: prompt.length + response.length },
    };
  }
}
