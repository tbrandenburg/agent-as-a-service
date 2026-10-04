"use strict";
const crypto = require("node:crypto");
function createHostLinkCaller(RED) {
  const callerId = `__node-red-cli-host-${crypto.randomBytes(8).toString("hex")}`;
  const pending = new Map();
  const returnLinkOutIds = new Set();
  const hookId = `onReceive.${callerId}`;

  // RED.nodes is internal. We only read the deployed node configuration;
  // no node is added, rewired, deployed or removed.
  RED.nodes.eachNode((config) => {
    if (config.type === "link out" && config.mode === "return") {
      returnLinkOutIds.add(config.id);
    }
  });

  RED.hooks.add(hookId, ({ msg, destination }) => {
    if (!returnLinkOutIds.has(destination.id)) return;

    const stack = msg?._linkSource;
    const source = stack?.[stack.length - 1];
    if (source?.node !== callerId) return;

    // Mirror LinkCallNode/FunctionNode cleanup before returning the result.
    stack.pop();
    if (stack.length === 0) delete msg._linkSource;

    const operation = pending.get(source.id);
    if (operation) {
      pending.delete(source.id);
      clearTimeout(operation.timer);
      operation.resolve(msg);
    }

    // Do not let LinkOutNode continue: it would try RED.nodes.getNode(callerId),
    // but the host intentionally is not a configured Node-RED node.
    return false;
  });

  function call(target, msg, { resume, flow: _flow, timeout = 5000, clone = true, onWarning } = {}) {
    const validation = { ok: true, targetId: target, warnings: [] };
    if (!validation.ok) {
      return Promise.reject(new Error(`preflight validation failed:\n- ${validation.errors.join("\n- ")}`));
    }
    if (typeof onWarning === "function") {
      for (const warning of validation.warnings) onWarning(warning);
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return Promise.reject(new TypeError("timeout must be a positive number of milliseconds"));
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return Promise.reject(new TypeError("msg must be an object"));
    }

    const targetNode = RED.nodes.getNode(validation.targetId);
    if (!targetNode || (resume ? targetNode.type !== "interaction" || targetNode.interaction?.version !== 1 : targetNode.type !== "link in")) {
      return Promise.reject(new Error(`link in '${validation.targetId}' not found`));
    }

    const callId = crypto.randomBytes(14).toString("hex");
    const input = clone ? RED.util.cloneMessage(msg) : msg;
    if (resume) input._linkSource = [];
    input._linkSource ??= [];
    input._linkSource.push({ node: callerId, id: callId });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(`link call timed out after ${timeout} ms`));
      }, timeout);

      pending.set(callId, { resolve, reject, timer });
      try {
        if (resume) targetNode.interaction.resume(resume.plan, input, resume.response);
        else targetNode.receive(input);
      } catch (error) {
        pending.delete(callId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function close(reason = new Error("host link caller closed")) {
    RED.hooks.remove(hookId);
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(reason);
    }
    pending.clear();
  }

  return { call, close };
}

module.exports = { createHostLinkCaller };
