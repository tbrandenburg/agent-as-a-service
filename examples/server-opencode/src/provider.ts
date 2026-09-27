import { spawn } from "node:child_process";
import type {
  IAgentProvider,
  MessageChunk,
  SendQueryOptions,
} from "@agent-as-a-service/agent-runtime";

type JsonEvent = {
  type?: unknown;
  sessionID?: unknown;
  [key: string]: unknown;
};

export class OpenCodeProvider implements IAgentProvider {
  constructor(
    private readonly cwd: string,
    private readonly timeoutMs: number,
    private readonly model = "opencode/big-pickle",
  ) {}

  getType() {
    return "opencode";
  }

  getCapabilities() {
    return { sessionResume: true };
  }

  async *sendQuery(
    prompt: string,
    cwd = this.cwd,
    resumeSessionId?: string,
    options: SendQueryOptions = {},
  ): AsyncGenerator<MessageChunk> {
    const args = [
      "run",
      "--format",
      "json",
      "--dir",
      cwd,
      "--model",
      this.model,
    ];
    if (resumeSessionId) args.push("--session", resumeSessionId);
    args.push(prompt);
    const child = spawn("opencode", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stderr = "";
    let sessionId: string | undefined;
    let assistant = "";
    let providerError: string | undefined;
    let parseError: string | undefined;
    let tools: string[] = [];
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stopChild = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, this.timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdout.setEncoding("utf8");
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const parse = (line: string) => {
      if (!line.trim()) return;
      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        throw new Error("opencode returned malformed JSON output");
      }
      if (typeof event.sessionID === "string") sessionId = event.sessionID;
      if (event.type === "text") {
        const part = event.part;
        const text =
          typeof part === "object" && part !== null && "text" in part
            ? (part as { text?: unknown }).text
            : event.text;
        if (typeof text === "string" && text) assistant += text;
      }
      if (event.type === "tool_use") {
        const part = event.part;
        const name =
          typeof part === "object" && part !== null && "tool" in part
            ? (part as { tool?: unknown }).tool
            : event.tool;
        if (typeof name === "string") tools.push(name);
      }
      if (event.type === "error")
        providerError = "opencode reported an agent error";
    };
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          parse(line);
        } catch (error) {
          parseError =
            error instanceof Error ? error.message : "Invalid opencode output";
          stopChild();
        }
      }
    });
    try {
      // stdout is collected while the subprocess runs so both pipes drain concurrently.
      const exit = await closed;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) throw new Error("opencode timed out");
      if (parseError) throw new Error(parseError);
      try {
        parse(buffer);
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : "Invalid opencode output",
        );
      }
      if (exit.code !== 0) {
        const diagnostic = stderr.trim().replace(/\s+/g, " ").slice(-500);
        throw new Error(
          diagnostic
            ? `opencode exited unsuccessfully: ${diagnostic}`
            : "opencode exited unsuccessfully",
        );
      }
      if (providerError) throw new Error(providerError);
      if (!sessionId) throw new Error("opencode did not return a session ID");
      if (!assistant.trim())
        throw new Error("opencode returned no assistant text");
      for (const toolName of tools) yield { type: "tool", toolName };
      yield { type: "assistant", content: assistant };
      yield {
        type: "result",
        sessionId,
        resumed: resumeSessionId ? sessionId === resumeSessionId : undefined,
      };
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (child.exitCode === null) stopChild();
    }
  }
}
