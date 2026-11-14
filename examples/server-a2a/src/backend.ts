export type Workflow = { id: string; name: string; description?: string };
export type Run = {
  id: string;
  status: string;
  output?: unknown;
  error?: { code: string } | null;
};

export class BackendError extends Error {}

export class Backend {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 5000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async listWorkflows(): Promise<Workflow[]> {
    const body = await this.request("/workflows");
    if (!isRecord(body) || !Array.isArray(body.items))
      throw new Error("Invalid backend response");
    return body.items.filter(isRecord).map((item) => ({
      id: stringValue(item.id),
      name: stringValue(item.name),
      ...(typeof item.description === "string"
        ? { description: item.description }
        : {}),
    }));
  }

  async startRun(workflowId: string, input: unknown): Promise<Run> {
    const body = await this.request("/runs", "POST", {
      target: { kind: "workflow", id: workflowId },
      input,
    });
    if (
      !isRecord(body) ||
      !isRecord(body.run) ||
      typeof body.run.id !== "string"
    )
      throw new Error("Invalid backend response");
    return toRun(body.run);
  }

  async getRun(runId: string): Promise<Run> {
    const body = await this.request(`/runs/${encodeURIComponent(runId)}`);
    if (!isRecord(body) || !isRecord(body.run))
      throw new Error("Invalid backend response");
    return toRun(body.run);
  }

  async cancelRun(runId: string): Promise<Run> {
    const body = await this.request(
      `/runs/${encodeURIComponent(runId)}/cancel`,
      "POST",
      {},
    );
    if (!isRecord(body) || !isRecord(body.run))
      throw new Error("Invalid backend response");
    return toRun(body.run);
  }

  private async request(
    path: string,
    method = "GET",
    payload?: unknown,
  ): Promise<unknown> {
    const response = await this.fetcher(
      new URL(`/api/v1${path}`, this.baseUrl),
      {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        isRecord(body) &&
        isRecord(body.error) &&
        typeof body.error.code === "string"
          ? safeCode(body.error.code)
          : "unknown";
      throw new BackendError(
        `Backend request failed (${response.status}, ${code})`,
      );
    }
    return body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid backend response");
  return value;
}

function toRun(run: Record<string, unknown>): Run {
  if (typeof run.id !== "string" || typeof run.status !== "string")
    throw new Error("Invalid backend response");
  return {
    id: run.id,
    status: run.status,
    ...(Object.hasOwn(run, "output") ? { output: run.output } : {}),
    ...(isRecord(run.error)
      ? {
          error: { code: safeCode(stringValue(run.error.code)) },
        }
      : {}),
  };
}

function safeCode(value: string): string {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
}
