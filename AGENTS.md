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

## Deliverable and validation scope

- The contract is the production deliverable; servers and clients are examples.
- Prioritize schema compatibility, engine neutrality, typed client conformance, documented semantics and generated OpenAPI fidelity.
- Add example behavior only to demonstrate contract capabilities or resolve concrete implementation ambiguities. Avoid unsolicited production-platform features, metric frameworks and broad refactors.
- Keep fast example regressions. Run native/runtime acceptance for relevant adapter changes and real-provider walkthroughs manually; inspect ports first and use `DEFAULT_MODEL=github-copilot/gpt-6-luna` for Node-RED model tests.
- Run `make check-contract` for contract validation and `make check` for workspace checks. Generated artifacts must match committed sources.

## Node-RED adapter principles

- Let Node-RED execute workflows; map only required contract behavior through its existing interfaces.
- Keep the mapping generic. Do not depend on private node internals or require instrumentation in each workflow.
- Add no abstraction or state for hypothetical needs. Report unsupported behavior and uncertain outcomes honestly.
- Before adding a subsystem, state the concrete missing behavior, why native Node-RED mechanisms fall short, and its lifecycle cost. Signal that tradeoff early.
- Diagnose intermittent failures with existing evidence before adding diagnostics or retries.

## Lessons Learned

- 2026-10-01: Pitfall: Native Link Out(return) snapshots omit empty wires, breaking exact deployment verification. Prevention rule/countermeasure: Normalize native Admin API representations on both sides and verify managed CRUD against a real runtime before accepting fixture-only checks.
- 2026-10-01: Pitfall: Replacing a native-link fixture through per-tab deployment left stale runtime wiring. Prevention rule/countermeasure: Use full native deployment for test-only graph replacement and restore the complete snapshot before provider acceptance.
- 2026-09-30: Pitfall: A filesystem proof chain replaced the agent task prompt with its bare topic, provoking tool searches and empty-output failures. Prevention rule/countermeasure: Preserve and restore task payloads across probes; regression-test the exact prompt reaching the agent.
- 2026-09-30: Pitfall: A direct authenticated CLI run passed while real workflows intermittently failed with agent exit code 0. Prevention rule/countermeasure: Require fresh Core and managed E2E and correlate terminal events with worker metrics before declaring model switching validated.
- 2026-09-30: Pitfall: Killing a worker host left its spawned model CLI running after worker cleanup. Prevention rule/countermeasure: launch each worker in an isolated process group and terminate the group on shutdown or crash.
- 2026-09-30: Pitfall: A provider session resumed successfully in its original directory but stalled when resumed from another project directory. Prevention rule/countermeasure: verify cross-directory resume with the real CLI and reject unsupported directory changes before accepting the run.
- 2026-09-29: Pitfall: Parallel Compose demos exhausted host storage after many project-scoped image builds, causing misleading readiness failures. Prevention rule/countermeasure: Check disk capacity before concurrent Docker E2E and remove only session-owned test images after teardown.
- 2026-09-29: Pitfall: Concurrent first-use OpenCode CLI processes raced while initializing local storage, failing fresh parallel workflows. Prevention rule/countermeasure: initialize CLI storage once during image build before allowing parallel agent invocations.
- 2026-09-27: Pitfall: A one-off real-provider failure was initially indistinguishable from an adapter regression. Prevention: reproduce provider failures with the direct CLI, then rerun the HTTP demo before attributing them to integration code.
- 2026-09-28: Pitfall: A worktree without local workspace links resolved package imports through the coordinator checkout, hiding type mismatches. Prevention rule/countermeasure: run `npm ci` in each worktree before typechecking or running demos.
- 2026-09-28: Pitfall: A Docker demo passed Express health before its private Node-RED flow loaded, causing an intermittent first-run failure. Prevention rule/countermeasure: wait for the private execution entry to be ready before starting real workflow E2E checks.
