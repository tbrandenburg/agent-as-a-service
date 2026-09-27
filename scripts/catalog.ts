import { readFileSync, writeFileSync } from "node:fs";
const spec = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
) as {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId: string;
        summary?: string;
        responses: Record<string, unknown>;
      }
    >
  >;
};
const implemented = new Set(["getHealth", "getStatus", "getOpenApiDocument"]);
const lines = [
  "# API catalog",
  "",
  "All operations are specified in the independent ts-rest contract under `/api/v1`. The generated OpenAPI file provides full request, response, parameter and error schemas. Health and OpenAPI are public; status and every resource operation require HTTP bearer authentication. The example adapter checks one development bearer token; an implementation must enforce its own ownership and authorization rules. Resource operations return structured HTTP 501 until a backend is installed.",
  "",
  "| Method | Path | Operation | Declared success | Example adapter |",
  "| --- | --- | --- | --- | --- |",
];
for (const [path, methods] of Object.entries(spec.paths).sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    const success = Object.keys(op.responses)
      .filter((s) => Number(s) >= 200 && Number(s) < 300)
      .join(", ");
    lines.push(
      `| ${method.toUpperCase()} | \`${path}\` | \`${op.operationId}\` | ${success} | ${implemented.has(op.operationId) ? "200" : "501"} |`,
    );
  }
}
lines.push(
  "",
  "Errors follow `{error:{code,message,details?}}`. Common statuses are 400, 401, 403, 404, 409, 429, 500, 501 and 503; workflow update also declares 412 and inline file writes declare 413. Service routes declare only applicable errors. List responses use explicit cursor pagination where relevant. `GET /health` is a small public probe outside the versioned contract. The [Archon REST parity map](rest-parity.md) links each source route to these operations.",
  "",
);
writeFileSync(new URL("../docs/catalog.md", import.meta.url), lines.join("\n"));
console.log(
  `Cataloged ${lines.filter((line) => line.startsWith("| ") && !line.startsWith("| Method") && !line.startsWith("| ---")).length} operations`,
);
