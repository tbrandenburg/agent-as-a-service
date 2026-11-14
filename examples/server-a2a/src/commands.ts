export type Command =
  | { operation: "workflows.list" }
  | {
      operation: "workflows.execute";
      parameters: { workflowId: string; input: unknown };
    };

export class CommandError extends Error {}

export function parseCommand(
  parts: Array<{ content?: { $case?: string; value?: unknown } }>,
): Command | "text-list" {
  if (parts.length !== 1) throw new Error("Send exactly one text or data part");
  const part = parts[0];
  if (part.content?.$case === "text" && part.content.value === "list workflows")
    return "text-list";
  if (part.content?.$case !== "data" || !isRecord(part.content.value))
    throw new CommandError(
      "Unsupported input; use 'list workflows' or a structured command",
    );
  const value = part.content.value;
  if (value.operation === "workflows.list")
    return { operation: "workflows.list" };
  if (value.operation !== "workflows.execute" || !isRecord(value.parameters))
    throw new CommandError("Unsupported management operation");
  if (
    typeof value.parameters.workflowId !== "string" ||
    value.parameters.workflowId.trim().length === 0 ||
    !Object.hasOwn(value.parameters, "input")
  ) {
    throw new CommandError("workflows.execute requires workflowId and input");
  }
  return {
    operation: "workflows.execute",
    parameters: {
      workflowId: value.parameters.workflowId,
      input: value.parameters.input,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
