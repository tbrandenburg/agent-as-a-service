const token = process.env.INTERNAL_TOKEN;
if (!token) throw new Error("INTERNAL_TOKEN is required");
const adminToken = process.env.NODE_RED_ADMIN_TOKEN;
if (!adminToken || adminToken === token || adminToken === process.env.API_TOKEN)
  throw new Error("A distinct NODE_RED_ADMIN_TOKEN is required");
if (process.env.CONTROLLED_FIXTURE === "true") {
  process.env.PATH = `/data/fixture:${process.env.PATH}`;
}

module.exports = {
  flowFile: "flows.json",
  adminAuth: {
    type: "credentials",
    users: [],
    tokens: async (provided) => {
      const { timingSafeEqual } = require("node:crypto");
      const actual = Buffer.from(provided);
      const expected = Buffer.from(adminToken);
      return actual.length === expected.length && timingSafeEqual(actual, expected)
        ? { username: "aaas-internal", permissions: ["flows.read", "flows.write"] }
        : null;
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
