# Agent REST contract

An independent, engine-neutral REST interface inspired by Archon's core resources. **Start here:** `packages/contract` defines the REST API. `packages/agent-runtime` contains optional, server-side agent provider interfaces; the REST contract does not import it. `examples/client` and `examples/server-express` show how to consume and implement the contract; they are examples, not required runtime dependencies. The default Express implementation validates requests and returns `501` for resource operations. It does not execute agents or persist data.

| Resource | Operations | Specification |
| --- | ---: | --- |
| Projects | 4 | `packages/contract/src/v1/projects.ts` |
| Conversations and messages | 8 | `packages/contract/src/v1/conversations.ts` |
| Workflows | 6 | `packages/contract/src/v1/workflows.ts` |
| Runs, events and artifacts | 10 | `packages/contract/src/v1/runs.ts` |
| Human interactions | 2 | `packages/contract/src/v1/interactions.ts` |
| Health, status and OpenAPI | 3 | `packages/contract/src/v1/system.ts` |

**30 resource operations and 3 service operations.** See the [endpoint catalog](docs/catalog.md), [generated OpenAPI](openapi.json) and [Archon REST accounting](docs/rest-parity.md). This contract represents REST only.

A small server can create a project and conversation with `{}`, send `{"content":"Hello"}`, or start a run with `{"input":"Hello"}`. If a backend supports input-free runs, `{}` is also valid. It may generate names and choose its only agent or workflow engine by default. To define a workflow, supply only `specification`; `name`, `engine` and `specificationVersion` are optional. IDs are opaque strings. Human reviewers can list pending interactions at `GET /api/v1/interactions`, inspect the referenced run, then submit a decision to `POST /api/v1/interactions/{interactionId}/decisions`. Retrying writes with `Idempotency-Key` and updating a workflow with `If-Match` are optional safeguards. A backend must reject requests whose omitted values cannot be resolved with its defaults. See [design decisions](docs/design.md).

For coding projects, `createProject` optionally accepts `localPath` (a path on the **server**) or `repositoryUrl`. `listWorkflows` includes saved and server-provided definitions; built-ins use `readOnly: true`. Poll `/runs/{runId}/events` or follow `/runs/{runId}/events/stream` for detailed execution events. Follow `/conversations/{conversationId}/events/stream` for chat progress across messages. The example backend returns `501` for these resource operations.

A `202` response from sending a message or starting a run guarantees that its run ID is immediately readable by `getRun`; it does not promise when execution finishes. SSE reconnects with `Last-Event-ID` replay later retained events, or return `409 event_history_unavailable` if complete replay is impossible. See [design decisions](docs/design.md) for the sequence rules.

Workflow reads and writes return an `ETag` such as `"v1"`; `updateWorkflow` optionally accepts it as `If-Match` and returns `412` on a stale tag. `Idempotency-Key` on message, run and decision writes deduplicates identical requests for at least 24 hours after acceptance. Oversized inline file requests return `413`; the allowed size is server-specific. SSE JSON payload and portable event schemas are included in OpenAPI through `x-sse-data-schema` and `x-sse-standard-events` references.

## Run locally

Requires Node.js 22.13+, npm and Make.

```sh
make install
make generate
make check
make dev
```

`make start` launches the example server without watch mode; `make format` formats TypeScript. Run `make help` for the main targets. The underlying npm scripts remain usable without Make. Generate the checked-in files before `make check` when the contract changes.

Run `make demo` for a nine-step HTTP walkthrough: authenticated status, project creation, chat and immediate run visibility, idempotent retry, workflow discovery, a paused approval, resumed completion, ordered events and an artifact. It starts a temporary Express server on a free local port, uses the typed client, prints each step and closes the server. Its separate `examples/server-express/src/adapters/demo.ts` backend keeps state in memory; its simulated `DemoAgent` implements `IAgentProvider` and streams chunks through `invokeProvider`. The backend turns chunks into run events and an assistant message, and retains provider session IDs per conversation for subsequent turns. The review workflow and approval gate remain simulated in the backend. Normal `make start` still uses the default `501` backend. The demo registers a sample repository URL but does not clone it, contact GitHub, or call an AI provider.

The demo backend implements only the operations exercised by this walkthrough; unrelated operations, including live SSE, still return `501`. It is an example implementation, separate from `packages/contract`.

Default address: `http://127.0.0.1:3091`; configurable `HOST`, `PORT`, `API_TOKEN` (default `dev-token`). `/api/v1/health` and `/api/v1/openapi.json` are public, as is the example's unversioned `/health` probe. Every other operation requires `Authorization: Bearer <token>` in the contract. The example uses `<API_TOKEN>` as a development token; it does not implement identity or ownership authorization. Authenticated `GET /api/v1/status` reports only whether the example's allowlisted `HOST`, `PORT` and `API_TOKEN` environment variables are explicitly set. It never returns their values or enumerates arbitrary process variables. Other server implementations can choose their own diagnostic names.

```sh
curl -H 'Authorization: Bearer dev-token' http://127.0.0.1:3091/api/v1/projects
# HTTP 501: backend not installed
curl -H 'Authorization: Bearer dev-token' http://127.0.0.1:3091/api/v1/status
curl http://127.0.0.1:3091/api/v1/openapi.json
# When a streaming backend is installed:
curl -N -H 'Authorization: Bearer dev-token' http://127.0.0.1:3091/api/v1/conversations/your-conversation-id/events/stream
```

`examples/client/src/index.ts` exports `createClient` (token optional), `sendMessage` and `startRun`; `examples/client/usage.ts` demonstrates chats, workflow runs and approvals. The [research](docs/research.md) and [journey fit](docs/journey-fit.md) explain scope.

## Optional agent provider interface and attribution

`@agent-as-a-service/agent-runtime` exports `IAgentProvider`, `MessageChunk`, `SendQueryOptions`, `ProviderCapabilities`, `TokenUsage` and `ResolvedModel`. This **server-side TypeScript interface is separate from the REST API**: it adds no routes, OpenAPI schemas, CLI commands or MCP tools. A custom server can implement it with its own SDK and translate streamed chunks into persisted messages, run events and SSE. `examples/server-express/src/adapters/provider-bridge.ts` shows the translation boundary and checks terminal results and session resume. `DemoAgent` exercises this boundary in the simulated demo; the normal server has no agent installed. The example does not implement live SSE.

**Attribution:** The provider design adapts Archon's [`IAgentProvider` and `MessageChunk` architecture](https://archon.diy/reference/architecture/#adding-ai-agent-providers) and its [community provider capability pattern](https://archon.diy/contributing/adding-a-community-provider/); Archon's source is [coleam00/Archon](https://github.com/coleam00/Archon). We preserve `sendQuery(prompt, cwd, resumeSessionId, options)`, `getType()`, `getCapabilities()`, familiar chunk names and the session resume result. The interface here is independently maintained: `cwd` is optional for non-filesystem agents; provider options are deliberately server-owned; workflow dispatch is an optional emitted chunk; capabilities beyond `sessionResume` are optional declarations. No Archon package is imported. These types do not claim exact source compatibility, and changes to Archon do not automatically change our contract.

## Using or implementing the contract

Import `contract` from `@agent-as-a-service/contract` in any HTTP server and implement its operations. The contract has no Express, database or mock dependency. The example Express implementation exports `ApiImplementation`, `registerContract`, and `createApp({ token, implementation })`. Supply your own typed implementation to `createApp`, or build a separate Fastify, Node or other server package around the same contract. `notImplementedRoutes` is exported as a development fallback for operations a new Express backend has not implemented yet. See the backend swap test in `examples/server-express/src/app.test.ts`.
