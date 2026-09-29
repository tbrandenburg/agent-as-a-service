const token = process.env.INTERNAL_TOKEN;
if (!token) throw new Error("INTERNAL_TOKEN is required");
if (process.env.CONTROLLED_FIXTURE === "true") {
  process.env.PATH = `/data/fixture:${process.env.PATH}`;
}

module.exports = {
  flowFile: "flows.json",
  nodeRedAgentsLifecycleObserver: async (record) => {
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
