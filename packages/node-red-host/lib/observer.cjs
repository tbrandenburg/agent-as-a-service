const { randomUUID } = require("node:crypto");

function createObserver(hooks, runId, deliver, limit = 4096, initialSequence = 0) {
  const pending = new WeakMap();
  const queue = [];
  const waiters = new Set();
  let sequence = initialSequence;
  let active = false;
  let sending = false;
  let delivery = Promise.resolve();
  let open = 0;
  let incomplete = null;
  const incompleteReason = (reason) => {
    if (!incomplete) incomplete = reason;
    for (const wake of waiters) wake();
  };
  const observe = (type, nodeId, executionId, status) => {
    if (!active || incomplete) return;
    if (sequence >= limit) { incompleteReason("queue_overflow"); return; }
    queue.push({ sequence: ++sequence, type, nodeId, executionId, status });
    void flush();
  };
  async function flush() {
    if (sending || !queue.length) return;
    sending = true;
    delivery = (async () => {
      while (queue.length) {
        const batch = queue.slice(0, 32);
        try { await deliver({ runId, observations: batch }); }
        catch { await deliver({ runId, observations: batch }); }
        queue.splice(0, batch.length);
      }
    })();
    try { await delivery; } catch {
      incompleteReason("callback_failed");
    } finally {
      sending = false;
    }
  }
  hooks.add("onReceive.aaas-observer", ({ msg, destination }) => {
    if (!active || incomplete || !msg || typeof msg !== "object") return;
    const nodes = pending.get(msg) || new Map();
    const entries = nodes.get(destination.id) || [];
    const id = randomUUID();
    entries.push(id);
    open++;
    nodes.set(destination.id, entries);
    pending.set(msg, nodes);
    observe("received", destination.id, id, "running");
  });
  hooks.add("onComplete.aaas-observer", ({ msg, node, error }) => {
    const nodes = msg && pending.get(msg);
    const entries = nodes?.get(node.id);
    if (!entries) return;
    if (entries.length !== 1) { incompleteReason("ambiguous_identity"); return; }
    nodes.delete(node.id);
    open--;
    if (open === 0) for (const wake of waiters) wake();
    observe("completed", node.id, entries[0], error ? "failed" : "completed");
  });
  hooks.add("onSend.aaas-observer", (events) => {
    for (const event of events) if (event.source?.id) observe("sent", event.source.id);
  });
  return {
    activate() { active = true; },
    async drain() {
      if (open && !incomplete) await new Promise((resolve) => {
        const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, 1000);
        waiters.add(wake);
      });
      active = false;
      await Promise.race([flushUntilIdle(), new Promise((resolve) => setTimeout(resolve, 3000))]);
      return { runId, incomplete: incomplete || (queue.length ? "drain_timeout" : undefined) };
    },
  };
  async function flushUntilIdle() {
    if (sending) await delivery.catch(() => {});
    if (queue.length && !incomplete) await flush();
  }
}

module.exports = { createObserver };
