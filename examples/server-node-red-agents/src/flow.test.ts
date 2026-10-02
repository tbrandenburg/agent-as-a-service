import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodes = JSON.parse(
  readFileSync(new URL("../node-red/flows.json", import.meta.url), "utf8"),
) as Record<string, unknown>[];

describe("Core native boundary", () => {
  it("calls one agent with input.text and returns its reply using native Link nodes", () => {
    expect(nodes.map((node) => node.type)).toEqual([
      "tab",
      "link in",
      "agent",
      "link out",
    ]);
    expect(nodes.find((node) => node.type === "link in")?.wires).toEqual([
      ["orchestrator"],
    ]);
    expect(nodes.find((node) => node.type === "agent")).toMatchObject({
      id: "orchestrator",
      name: "orchestrator",
      prompt: "input.text",
      promptType: "msg",
      model: "DEFAULT_MODEL",
      modelType: "env",
      wires: [["workflow-return"], []],
    });
    expect(nodes.find((node) => node.type === "agent")).not.toHaveProperty(
      "cwd",
    );
    expect(nodes.find((node) => node.id === "workflow-return")).toMatchObject({
      type: "link out",
      mode: "return",
    });
    expect(JSON.stringify(nodes)).not.toMatch(
      /INTERNAL_TOKEN|\/finalize|reviewer|summary|probe/,
    );
  });
});
