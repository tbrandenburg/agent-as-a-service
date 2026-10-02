const token = process.env.INTERNAL_TOKEN;
if (!token) throw new Error("INTERNAL_TOKEN is required");

module.exports = {
  flowFile: "flows.json",
  httpNodeRoot: process.env.WORKER_RUNTIME === "true" ? "/" : false,
  fileWorkingDirectory: "/data/agent-work",
  logging: {
    console: {
      level: "info",
      metrics: process.env.WORKER_RUNTIME === "true" && process.env.NODE_RED_WORKER_METRICS === "true",
      audit: false,
    },
  },
  nodeRedAgentsLifecycleObserver: async (record) => {
    if (record.type === "execution.terminal" && record.status !== "completed") {
      const detail = record.output?.errorDetail;
      console.error("Agent execution failed", {
        nodeId: record.nodeId,
        errorType: typeof detail?.name === "string" ? detail.name : "unknown",
        exitCode: record.output?.exitCode ?? null,
        signal: record.output?.signal ?? null,
        timedOut: record.output?.timedOut === true,
      });
    }
    const response = await fetch("http://api:3095/observations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(65_000),
    });
    if (!response.ok) throw new Error(`Observation rejected (${response.status})`);
  },
};
