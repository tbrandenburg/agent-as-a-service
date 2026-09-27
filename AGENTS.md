# Agent as a Service

This repository defines an engine-neutral REST contract for projects, conversations, workflows, runs, events, artifacts, and human interactions. The contract is the source of truth; the server and client are examples. See `README.md` for usage and `docs/design.md` for API decisions. Requires Node.js 22.13+, npm, and Make.

## Folder structure

| Path | Purpose |
| --- | --- |
| `packages/contract/` | ts-rest/Zod API contract and resource schemas; independent of the HTTP server and agent provider. |
| `packages/agent-runtime/` | Optional server-side agent provider interfaces. |
| `examples/server-express/` | Express server using the official ts-rest adapter; the default backend validates requests and returns 501 for unimplemented resource operations. `src/adapters/demo.ts` provides the in-memory demo backend. |
| `examples/client/` | Typed API client, usage example, and end-to-end demo. |
| `scripts/` | Generate OpenAPI and the catalog/parity documents; validate the API and Archon route accounting. |
| `docs/` | API catalog, design decisions, research, event semantics, and parity documentation. |
| `openapi.json` | Generated OpenAPI document served by the example server. |

## Make targets

| Target | What it does |
| --- | --- |
| `make help` | Show the main commands. |
| `make install` | Install workspace dependencies from the lockfile with `npm ci`. |
| `make generate` | Regenerate OpenAPI, the endpoint catalog, and the Archon parity document. |
| `make openapi` | Regenerate `openapi.json`. |
| `make catalog` | Regenerate `docs/catalog.md` from OpenAPI. |
| `make parity-doc` | Regenerate `docs/rest-parity.md`. |
| `make check` | Run typecheck, tests, OpenAPI and parity validation, and formatting check. |
| `make typecheck` | Type-check TypeScript without emitting files. |
| `make test` | Run Vitest tests. |
| `make validate-openapi` | Validate the generated OpenAPI document and API invariants. |
| `make parity` | Check Archon route accounting. |
| `make format` | Format TypeScript under `packages/`, `scripts/`, and `examples/`. |
| `make dev` | Start the Express example in watch mode. |
| `make start` | Start the Express example server. |
| `make demo` | Run the simulated end-to-end workflow against an in-memory server. |

When changing the contract, run `make generate` before `make check` and include the regenerated artifacts. Keep provider-specific logic out of `packages/contract/`.
