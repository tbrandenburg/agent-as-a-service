/** Optional server-side provider contract. Not part of the REST or OpenAPI surface.
 * Adapted from Archon's IAgentProvider and MessageChunk design; see README.md.
 */
export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd?: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk>;
  getType(): string;
  getCapabilities(): ProviderCapabilities;
}

/** Server-owned configuration, never accepted verbatim from an HTTP request. */
export interface SendQueryOptions {
  model?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Provider-specific settings belong to the host, not the public REST contract. */
  providerOptions?: Record<string, unknown>;
}

/** Declare support only when the provider actually implements the behavior. */
export interface ProviderCapabilities {
  sessionResume: boolean;
  sessionFork?: boolean;
  mcp?: boolean;
  hooks?: boolean;
  skills?: boolean;
  agents?: boolean;
  toolRestrictions?: boolean;
  structuredOutput?: false | "enforced" | "best-effort";
  requiresAllPropertiesRequired?: boolean;
  envInjection?: boolean;
  costControl?: boolean;
  costReporting?: boolean;
  tokenReporting?: boolean;
  stopReasonReporting?: boolean;
  turnCountReporting?: boolean;
  resolvedModelReporting?: boolean;
  effortControl?: boolean;
  fallbackModel?: boolean;
  sandbox?: boolean;
  settingSources?: boolean;
  nativeTools?: boolean;
  containerExec?: boolean;
  knownToolNames?: readonly string[];
  renamedTools?: Readonly<Record<string, string>>;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ResolvedModel {
  provider?: string;
  model: string;
}

/** An agent may emit any subset of progress chunks; `result` closes a successful
 * stream (or reports a provider failure via isError). A thrown error also fails it.
 * Store sessionId only after the final result; do not assume a requested resume worked.
 */
export type MessageChunk =
  | { type: "assistant"; content: string }
  | { type: "system"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "result";
      sessionId?: string;
      tokens?: TokenUsage;
      structuredOutput?: unknown;
      isError?: boolean;
      errorSubtype?: string;
      errors?: string[];
      cost?: number;
      stopReason?: string;
      numTurns?: number;
      resolvedModel?: ResolvedModel;
      /** Present on a resume attempt: true = restored, false = fresh session. */
      resumed?: boolean;
    }
  | { type: "rate_limit"; rateLimitInfo: Record<string, unknown> }
  | {
      type: "tool";
      toolName: string;
      toolInput?: Record<string, unknown>;
      toolCallId?: string;
    }
  | {
      type: "tool_result";
      toolName: string;
      toolOutput: string;
      toolCallId?: string;
    }
  /** Optional orchestration signal; only a host with a workflow engine acts on it. */
  | {
      type: "workflow_dispatch";
      workerConversationId: string;
      workflowName: string;
    };
