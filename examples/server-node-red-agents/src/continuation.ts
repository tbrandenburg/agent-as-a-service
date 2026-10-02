import { randomUUID } from "node:crypto";
import type { Specification } from "./native.js";

/** Copy only the current agent; Node-RED owns configuration resolution. */
export function continuation(node: Record<string, unknown>): Specification {
  const tab = randomUUID();
  const entry = randomUUID();
  const boundary = randomUUID();
  return {
    entry,
    flows: [
      { id: tab, type: "tab", label: "Conversation turn", disabled: false },
      {
        id: entry,
        type: "link in",
        z: tab,
        x: 100,
        y: 100,
        links: [],
        wires: [[node.id]],
      },
      {
        ...structuredClone(node),
        z: tab,
        x: 250,
        y: 100,
        invocation: "prompt",
        prompt: "input.text",
        promptType: "msg",
        sessionIdProp: "input.sessionID",
        sessionIdPropType: "msg",
        wires: [[boundary], []],
      },
      {
        id: boundary,
        type: "link out",
        z: tab,
        x: 450,
        y: 100,
        mode: "return",
        links: [],
        wires: [],
      },
    ],
  };
}
