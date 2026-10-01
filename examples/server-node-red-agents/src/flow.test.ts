import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Node } from "./managed.js";

const nodes = JSON.parse(
  readFileSync(new URL("../node-red/flows.json", import.meta.url), "utf8"),
) as Node[];

describe("Core native boundary", () => {
  it("calls one agent with input.text and returns its reply using native Link nodes", () => {
    expect(nodes.map((node) => node.type)).toEqual([
      "tab",
      "link in",
      "agent",
      "link out",
      "catch",
    ]);
    expect(nodes.find((node) => node.type === "link in")?.wires).toEqual([
      ["core-agent"],
    ]);
    expect(nodes.find((node) => node.type === "agent")).toMatchObject({
      id: "core-agent",
      prompt: "input.text",
      promptType: "msg",
      model: "DEFAULT_MODEL",
      modelType: "env",
      wires: [["workflow-return"], ["workflow-return"]],
    });
    expect(nodes.find((node) => node.id === "workflow-return")).toMatchObject({
      type: "link out",
      mode: "return",
    });
    expect(JSON.stringify(nodes)).not.toMatch(
      /INTERNAL_TOKEN|\/finalize|reviewer|summary|probe/,
    );
  });
});
