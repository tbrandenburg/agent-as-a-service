import type { Input } from "./native.js";

export const echo = (
  func = "msg.payload=msg.input;msg.runId='forged';msg.status='failed';return msg;",
): Input => ({
  name: "Native echo",
  engine: "node-red",
  specification: {
    entry: "entry",
    flows: [
      { id: "main", type: "tab", label: "Main" },
      { id: "entry", z: "main", type: "link in", wires: [["work"]] },
      {
        id: "work",
        z: "main",
        type: "function",
        outputs: 1,
        func,
        wires: [["return"]],
      },
      { id: "return", z: "main", type: "link out", mode: "return", links: [] },
    ].map((node, index) => ({ ...node, x: 100 + index * 40, y: 100 })),
  },
});

export const multiply: Input = {
  name: "Multitab multiplication",
  engine: "node-red",
  specification: {
    entry: "entry",
    flows: [
      { id: "first", type: "tab", label: "Public" },
      { id: "second", type: "tab", label: "Internal" },
      { id: "entry", type: "link in", z: "first", wires: [["cross"]] },
      {
        id: "cross",
        type: "link out",
        z: "first",
        mode: "link",
        links: ["internal"],
        wires: [],
      },
      {
        id: "internal",
        type: "link in",
        z: "second",
        links: ["cross"],
        wires: [["instance"]],
      },
      {
        id: "multiply",
        type: "subflow",
        name: "Multiply",
        in: [{ x: 40, y: 40, wires: [{ id: "calculate" }] }],
        out: [{ x: 300, y: 40, wires: [{ id: "calculate", port: 0 }] }],
      },
      {
        id: "calculate",
        type: "function",
        z: "multiply",
        outputs: 1,
        func: "msg.payload=msg.input.a*msg.input.b;return msg;",
        wires: [[]],
      },
      {
        id: "instance",
        type: "subflow:multiply",
        z: "second",
        wires: [["change"]],
      },
      {
        id: "change",
        type: "change",
        z: "second",
        rules: [{ t: "set", p: "trusted", pt: "msg", to: "true", tot: "bool" }],
        wires: [["switch"]],
      },
      {
        id: "switch",
        type: "switch",
        z: "second",
        property: "trusted",
        propertyType: "msg",
        rules: [{ t: "true" }],
        checkall: "true",
        outputs: 1,
        wires: [["return"]],
      },
      {
        id: "return",
        type: "link out",
        z: "second",
        mode: "return",
        links: [],
        wires: [],
      },
      {
        id: "startup",
        type: "inject",
        z: "first",
        once: true,
        onceDelay: "0.1",
        props: [{ p: "payload" }],
        payload: "startup",
        payloadType: "str",
        wires: [[]],
      },
    ].map((node, index) =>
      node.type === "tab" || node.type === "subflow"
        ? node
        : { ...node, x: 100 + index * 40, y: 100 },
    ),
  },
};
