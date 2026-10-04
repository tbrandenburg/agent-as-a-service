const { join } = require("node:path");

function serializable(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
  if (Array.isArray(value) && Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) return false;
  if (!Array.isArray(value) && Object.prototype.toString.call(value) !== "[object Object]") return false;
  seen.add(value);
  const valid = Reflect.ownKeys(value).every((key) => {
    if (Array.isArray(value) && key === "length") return true;
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor.enumerable && "value" in descriptor && serializable(descriptor.value, seen);
  });
  seen.delete(value);
  return valid;
}

function validateResume(RED, value, dir) {
  if (!value || !serializable(value) || !value.msg || typeof value.msg !== "object" || Array.isArray(value.msg)) throw new Error("Invalid continuation message");
  const node = RED.nodes.getNode(value.plan?.nodeId);
  if (!node || node.type !== "interaction" || node.interaction?.version !== 1) throw new Error("Interaction node unavailable");
  // Use the installed node's own plan/decision validator before consuming a decision.
  const interactionPath = process.env.NODE_RED_AGENTS_INTERACTION_MODULE || join(dir, "node_modules/@tbrandenburg/node-red-agents/nodes/interaction/lib/interaction.js");
  const interaction = require(interactionPath);
  interaction.response(value.plan, value.response, node);
  if (value.msg._linkSource !== undefined && (!Array.isArray(value.msg._linkSource) || value.msg._linkSource.length !== 1)) throw new Error("Nested Link Call continuation is unsupported");
}

module.exports = { serializable, validateResume };
