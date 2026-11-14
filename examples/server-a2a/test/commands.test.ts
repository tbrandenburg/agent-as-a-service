import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands.js";

describe("management commands", () => {
  it("recognizes the exact discovery phrase and a valid execute command", () => {
    expect(
      parseCommand([{ content: { $case: "text", value: "list workflows" } }]),
    ).toBe("text-list");
    expect(
      parseCommand([
        {
          content: {
            $case: "data",
            value: {
              operation: "workflows.execute",
              parameters: {
                workflowId: "multiply",
                input: { a: 13.75, b: -8 },
              },
            },
          },
        },
      ]),
    ).toEqual({
      operation: "workflows.execute",
      parameters: { workflowId: "multiply", input: { a: 13.75, b: -8 } },
    });
  });

  it("rejects malformed commands without accepting near-match natural language", () => {
    expect(() =>
      parseCommand([{ content: { $case: "text", value: "show workflows" } }]),
    ).toThrow("Unsupported input; use 'list workflows'");
    expect(() =>
      parseCommand([
        {
          content: {
            $case: "data",
            value: { operation: "workflows.execute", parameters: {} },
          },
        },
      ]),
    ).toThrow("requires workflowId and input");
  });
});
