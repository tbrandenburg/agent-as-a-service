# Agent as a Service

This repository defines an engine-neutral REST contract for projects, conversations, workflows, runs, events, artifacts, and human interactions. The contract is the source of truth; the server and client are examples. See `README.md` for usage and `docs/design.md` for API decisions. Requires Node.js 22.13+, npm, and Make.

## Folder structure

| Path | Purpose |
| --- | --- |
| `packages/contract/` | ts-rest/Zod API contract and resource schemas; independent of the HTTP server and agent provider. |
| `packages/agent-runtime/` | Optional server-side agent provider interfaces. |
| `examples/server-express/` | Express server using the official ts-rest adapter; the default backend validates requests and returns 501 for unimplemented resource operations. `src/adapters/demo.ts` provides the in-memory demo backend. |
| `examples/server-opencode/` | Dockerized in-memory Express contract backend that runs the fixed `opencode/big-pickle` CLI for conversation messages. |
| `examples/server-node-red-agents/` | Node-RED-backed contract example: private worker per run, managed workflow tabs, project working directories, and agent conversations. |
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
| `make start-opencode` | Start the local OpenCode-backed example server; Docker Compose lifecycle is documented in `examples/server-opencode/README.md`. |
| `make demo-express` | Run the simulated end-to-end workflow against an in-memory server. |
| `make demo-opencode` | Build Docker and run the real opencode-backed HTTP walkthrough through its localhost published port; requires Docker Compose, curl, host Node/npm, and outbound model access, but no host OpenCode CLI or provider credentials. |

The OpenCode Docker example exposes the complete contract. Conversation/message/run/event operations use an in-memory backend; other resource operations return typed `501`. HTTP routes require a runtime `API_TOKEN`; the fixed Big Pickle model does not require provider authentication. Restarting the backend loses conversation-to-OpenCode-session mappings, and the demo container is ephemeral. Port 3092 must be free for `make demo-opencode`.

When changing the contract, run `make generate` before `make check` and include the regenerated artifacts. Keep provider-specific logic out of `packages/contract/`.

## Node-RED adapter boundary (KISS / YAGNI)

For `examples/server-node-red-agents/`, treat Node-RED as the workflow engine. The server maps HTTP resources to the existing Node-RED Admin API, process-scoped run workers, runtime hooks already in use, and the published agent lifecycle signal. It does not interpret or schedule arbitrary flow graphs itself. Core and managed workflows share the same execution path; managed workflow support is deliberately restricted to `managed-v1` rather than a promise to import any Node-RED graph.

- Before adding plumbing, name the **specific contract behavior** that is missing, the Node-RED primitive that supplies it, and the smallest mapping between them. Use existing run events, native metrics/error logs, or a typed `501` for unsupported operations where that honestly satisfies the requirement. Do not add speculative observability, retry, storage, orchestration, or provider abstractions.
- Keep run-wide facts on the run worker and node-specific facts at their actual source. Do not require user workflows or community nodes to carry adapter metadata or honor agent-only conventions such as `msg.cwd`. Node-RED receive/send activity is not proof of node success; report unconfirmed completion honestly.
- Isolate an intermittent failure with existing logs, events, and a direct CLI reproduction before expanding the adapter. Changes to a published node's failure fields belong in `node-red-agents` when evidence points there; avoid parsing its private output or adding per-version knowledge to this server.
- If a request cannot be met through a small mapping, **signal early** in the issue or PR: describe the missing Node-RED capability, the added lifecycle/state cost, and the smallest limited alternative. Agree on scope before building another callback protocol, worker host, tracing store, or general graph verifier. Keep manual E2E checks proportional to the behavior being changed.


## Lessons Learned

- 2026-09-30: Pitfall: Killing a worker host left its spawned model CLI running after worker cleanup. Prevention rule/countermeasure: launch each worker in an isolated process group and terminate the group on shutdown or crash.
- 2026-09-30: Pitfall: A provider session resumed successfully in its original directory but stalled when resumed from another project directory. Prevention rule/countermeasure: verify cross-directory resume with the real CLI and reject unsupported directory changes before accepting the run.
- 2026-09-29: Pitfall: Parallel Compose demos exhausted host storage after many project-scoped image builds, causing misleading readiness failures. Prevention rule/countermeasure: Check disk capacity before concurrent Docker E2E and remove only session-owned test images after teardown.
- 2026-09-29: Pitfall: Concurrent first-use OpenCode CLI processes raced while initializing local storage, failing fresh parallel workflows. Prevention rule/countermeasure: initialize CLI storage once during image build before allowing parallel agent invocations.
- 2026-09-27: Pitfall: A one-off real-provider failure was initially indistinguishable from an adapter regression. Prevention: reproduce provider failures with the direct CLI, then rerun the HTTP demo before attributing them to integration code.
- 2026-09-28: Pitfall: A worktree without local workspace links resolved package imports through the coordinator checkout, hiding type mismatches. Prevention rule/countermeasure: run `npm ci` in each worktree before typechecking or running demos.
- 2026-09-28: Pitfall: A Docker demo passed Express health before its private Node-RED flow loaded, causing an intermittent first-run failure. Prevention rule/countermeasure: wait for the private execution entry to be ready before starting real workflow E2E checks.
