import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import formats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { contract, schemas } from "./index.js";

const document = z
  .object({
    components: z.object({ schemas: z.record(z.unknown()) }),
    paths: z.record(
      z.record(
        z.object({
          operationId: z.string(),
          requestBody: z
            .object({
              content: z.record(z.object({ schema: z.record(z.unknown()) })),
            })
            .optional(),
          responses: z.record(
            z.object({
              content: z
                .record(z.object({ schema: z.record(z.unknown()) }))
                .optional(),
            }),
          ),
        }),
      ),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8"),
    ),
  );
const ajv = new Ajv({ strict: false });
formats.default(ajv);
// Translate OpenAPI's nullable union annotation to JSON Schema for Ajv.
const jsonSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (typeof value !== "object" || value === null) return value;
  const { nullable, ...properties } = value as Record<string, unknown>;
  const schema = Object.fromEntries(
    Object.entries(properties).map(([key, item]) => [key, jsonSchema(item)]),
  );
  return nullable === true ? { anyOf: [schema, { type: "null" }] } : schema;
};
const compile = (schema: Record<string, unknown>) =>
  ajv.compile(
    jsonSchema({ ...schema, components: document.components }) as Record<
      string,
      unknown
    >,
  );
const routes = {
  startRun: contract.runs.startRun,
  getRun: contract.runs.getRun,
  createProject: contract.projects.createProject,
  sendMessage: contract.conversations.sendMessage,
  createWorkflow: contract.workflows.createWorkflow,
};
const examples = z
  .array(
    z.object({
      operation: z.enum([
        "startRun",
        "getRun",
        "createProject",
        "sendMessage",
        "createWorkflow",
      ]),
      kind: z.enum(["request", "response"]),
      status: z.number().optional(),
      value: z.unknown(),
    }),
  )
  .min(1)
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../docs/api-examples.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const operation = (name: string) => {
  const found = Object.values(document.paths)
    .flatMap(Object.values)
    .find((entry) => entry.operationId === name);
  if (!found) throw new Error(`Missing published operation ${name}`);
  return found;
};
const publishedRequest = compile(
  operation("startRun").requestBody!.content["application/json"].schema,
);
const publishedRun = compile(
  operation("getRun").responses["200"].content!["application/json"].schema,
);
const base = {
  id: "run",
  status: "completed",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("published contract conformance", () => {
  it.each(examples)(
    "validates published $operation $kind example",
    (example) => {
      const route = routes[example.operation];
      const schema =
        example.kind === "request"
          ? "body" in route
            ? route.body
            : undefined
          : Object.entries(route.responses).find(
              ([status]) => status === String(example.status),
            )?.[1];
      expect(schema instanceof z.ZodType).toBe(true);
      if (!(schema instanceof z.ZodType))
        throw new Error("Example has no JSON schema");
      expect(schema.safeParse(example.value).success).toBe(true);
      const wire = operation(example.operation);
      const json =
        example.kind === "request"
          ? wire.requestBody?.content["application/json"].schema
          : wire.responses[String(example.status)]?.content?.[
              "application/json"
            ].schema;
      if (!json) throw new Error("Example missing from OpenAPI");
      expect(compile(json)(example.value)).toBe(true);
    },
  );
  it.each([
    ["input omitted", {}, true],
    [
      "object input",
      { input: { nested: [true, 3, { mode: "review" }] } },
      true,
    ],
    ["string input", { input: "review" }, true],
    ["parts input", { input: [{ type: "data", data: { count: 2 } }] }, true],
    ["empty string", { input: "" }, true],
    ["empty array", { input: [] }, true],
    ["null input", { input: null }, true],
    ["numeric input", { input: 2 }, true],
    ["generic object array", { input: [{ type: "text", text: "" }] }, true],
    ["unknown envelope field", { inputs: "wrong" }, false],
    ["empty target ID", { target: { kind: "agent", agentId: "" } }, false],
  ])("agrees on %s", (_name, value, valid) => {
    expect(schemas.runStart.safeParse(value).success).toBe(valid);
    expect(publishedRequest(value)).toBe(valid);
  });
  it.each([
    [undefined, true],
    [null, true],
    ["", true],
    [[], true],
    [[{ type: "file", name: "a", contentBase64: "eA==" }], true],
    [{ generic: true }, true],
    [42, true],
    [[{ type: "file", name: "a" }], true],
  ])("preserves optional/null output boundaries for %j", (output, valid) => {
    const detail = {
      run: { ...base, ...(output === undefined ? {} : { output }) },
    };
    expect(schemas.runDetail.safeParse(detail).success).toBe(valid);
    expect(publishedRun(detail)).toBe(valid);
    expect(schemas.runOutput.safeParse(output).success).toBe(
      valid && output !== undefined,
    );
  });
  it("retains Zod-only cross-field validation even where OpenAPI cannot express it", () => {
    const value = {
      run: { ...base, conversationId: "primary" },
      conversations: [],
    };
    expect(schemas.runDetail.safeParse(value).success).toBe(false);
    expect(publishedRun(value)).toBe(true);
  });
});
