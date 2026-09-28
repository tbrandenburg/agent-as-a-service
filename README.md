# Agent as a Service

**An engine-neutral REST contract for agent projects, conversations, workflows, runs, events, artifacts, and human decisions.**

Use it as a typed API specification when building an agent backend or client. The contract defines the HTTP surface independently of any provider, database, or server framework.

[OpenAPI](openapi.json) · [Endpoint catalog](docs/catalog.md) · [Design decisions](docs/design.md) · [MIT License](LICENSE)

> This repository is a contract and example implementation, not a hosted service or ready-to-run agent platform. The standard Express example returns `501 Not Implemented` for resource operations. The simulated demo is in-memory; [`server-opencode`](examples/server-opencode) runs OpenCode for conversation messages, [`server-node-red`](examples/server-node-red) runs one fixed workflow through a private Node-RED container, and [`server-node-red-agents`](examples/server-node-red-agents) runs a fixed writer → reviewer flow with private checkpointing.

## What the contract covers

| Resource | Operations | Contract |
| --- | ---: | --- |
| Projects | 4 | [projects.ts](packages/contract/src/v1/projects.ts) |
| Conversations and messages | 8 | [conversations.ts](packages/contract/src/v1/conversations.ts) |
| Workflows | 6 | [workflows.ts](packages/contract/src/v1/workflows.ts) |
| Runs, events, and artifacts | 10 | [runs.ts](packages/contract/src/v1/runs.ts) |
| Human interactions | 2 | [interactions.ts](packages/contract/src/v1/interactions.ts) |
| Health, status, and OpenAPI | 3 | [system.ts](packages/contract/src/v1/system.ts) |

That is **30 resource operations and 3 service operations**. The contract also specifies:

- Typed requests, responses, and errors with ts-rest and Zod.
- Run acceptance that makes the returned run immediately readable.
- Optional run-detail `conversations` links for discovering public conversations created during execution; omitted for legacy responses and runs whose backend cannot track them.
- Optional idempotency keys for safe retries and ETags for workflow updates.
- Ordered run and conversation events, including resumable SSE semantics.
- Human decisions for runs that need approval or feedback.
- Generated OpenAPI, with portable event payloads described in extensions.

The API contract is the source of truth. The Express server, typed client, and demo are examples that can be replaced independently.

`GET /api/v1/runs/:runId` can include `conversations: [{ conversationId: "generated-1", nodeId: "review" }]` alongside `run`. When provided, this is the complete snapshot of public conversation IDs linked to that run; `nodeId` is optional and opaque. The optional `run.conversationId` remains usable by older clients and, if non-null alongside the list, must appear in it. An omitted list does not assert that no other conversations exist; `[]` explicitly reports none at that moment. Use the existing conversation and messages routes to read each linked ID. See [design decisions](docs/design.md) for the snapshot and authorization rules.

## Try it locally

Requirements: Node.js 22.13 or newer, npm, and Make.

```sh
make install
make generate
make check
make demo-express
```

`make demo-express` runs a simulated end-to-end workflow against a temporary in-memory Express server. It exercises project creation, chat, a workflow run, human approval, events, and an artifact; all state disappears when the process exits. `make demo-opencode` builds and starts the Dockerized CLI-backed contract server and walks through authenticated conversation, real Big Pickle replies, runs, ordered events, and session continuation at `http://127.0.0.1:3092`. It shows expected rejection checks separately; projects, workflows, approvals, and artifacts are not implemented in that example. It requires Docker Compose and outbound model access, but no host OpenCode CLI or provider credentials. Supply the contract's runtime bearer token with `API_TOKEN`; see [`examples/server-opencode/README.md`](examples/server-opencode/README.md).

`API_TOKEN=dev-token make demo-node-red` builds two Docker containers and walks through the unchanged authenticated workflow/run contract at `http://127.0.0.1:3093`. Node-RED stays private; the host needs Docker Compose, curl, Node/npm, Make, and `ss`, but no Node-RED installation. See [`examples/server-node-red/README.md`](examples/server-node-red/README.md).

`API_TOKEN=dev-token make demo-node-red-agents` runs the Dockerized, real `opencode/big-pickle` writer/reviewer workflow at `http://127.0.0.1:3094` with no provider credentials. See [`examples/server-node-red-agents/README.md`](examples/server-node-red-agents/README.md) for input conventions, version pins, checkpoint behavior, and limits.

To start the default example server instead:

```sh
make start
```

It listens on `http://127.0.0.1:3091` by default. Configure `HOST`, `PORT`, and `API_TOKEN` in the environment. Health and OpenAPI discovery are public; other routes require a bearer token. The default backend intentionally has no persistence or agent provider.

## Make targets

| Target | Purpose |
| --- | --- |
| `make install` | Install locked workspace dependencies. |
| `make generate` | Regenerate OpenAPI, catalog, and REST parity documents. |
| `make check` | Run lint, typecheck, tests, OpenAPI/parity validation, and formatting checks. |
| `make security` | Audit the root and Node-RED agent npm lockfiles. |
| `make lint` | Lint TypeScript source with Oxlint. |
| `make format-check` | Check TypeScript formatting with Prettier. |
| `make demo-express` | Run the simulated HTTP walkthrough. |
| `make demo-opencode` | Build Docker and run the real published-port OpenCode walkthrough. |
| `make demo-node-red` | Build Docker and run the private Node-RED workflow walkthrough. |
| `make demo-node-red-agents` | Build Docker and run the real writer/reviewer walkthrough. |
| `make start` / `make dev` | Start the Express example normally or in watch mode. |
| `make start-opencode` | Start the OpenCode-backed example server locally. |
| `make start-node-red` | Start the Node-RED-backed API server locally (requires Node-RED reachable at `NODE_RED_URL`). |
| `make help` | List the main targets. |

The complete command list is in [`Makefile`](Makefile). After changing the contract, run `make generate` before `make check` and commit the generated files.

GitHub Actions runs four independent `Checks` jobs on pushes and pull requests: Security (`make security`), Lint (`make lint`), Format (`make format-check`), and Tests (`make typecheck`, `make test`, `make validate-openapi`, `make parity`). Security audits both the root and Node-RED agent lockfiles. Install dependencies with `make install` before running individual checks locally. Docker-backed walkthroughs remain separate manual checks.

## Build a client or server

The contract is exported by `@agent-as-a-service/contract`. A client can use `@ts-rest/core` to call the API with end-to-end inferred types. The example client in [`examples/client`](examples/client) shows authenticated requests, chat, runs, and decisions.

Implement the contract with `ApiImplementation` and `registerContract` from [`examples/server-express`](examples/server-express), or map the same contract to another HTTP framework. The default implementation is a 501 fallback; [`adapters/demo.ts`](examples/server-express/src/adapters/demo.ts) supplies a simulated backend for the demo.

```ts
import { createClient, sendMessage } from "./examples/client/src/index.js";

const api = createClient("http://127.0.0.1:3091", "dev-token");
const conversation = await api.conversations.createConversation({ body: {} });

if (conversation.status === 201) {
  const accepted = await sendMessage(
    api,
    conversation.body.id,
    "Review this change",
  );

  if (accepted.status === 202) {
    // The run ID is immediately available for getRun or event polling.
    console.log(accepted.body.run.id);
  }
}
```

See [`examples/client/usage.ts`](examples/client/usage.ts) for more calls and [`docs/design.md`](docs/design.md) for defaults, authentication, idempotency, ETags, and event behavior.

## Optional agent provider interface

[`packages/agent-runtime`](packages/agent-runtime) defines a server-side `IAgentProvider` interface. It is separate from the REST contract: it adds no API routes and has no provider SDK dependency. The example [provider bridge](examples/server-express/src/adapters/provider-bridge.ts) shows how an implementation can translate provider output into messages and run events.

The provider shape is informed by Archon’s [`IAgentProvider` architecture](https://archon.diy/reference/architecture/#adding-ai-agent-providers) and [community provider capability pattern](https://archon.diy/contributing/adding-a-community-provider/). It is independently maintained and does not claim exact source compatibility.

## Project layout

- `packages/contract` — engine-neutral REST contract and schemas.
- `packages/agent-runtime` — optional TypeScript provider interface.
- `examples/server-express` — Express transport, default backend, and simulated demo backend.
- `examples/server-opencode` — small in-memory HTTP backend using the real OpenCode CLI.
- `examples/server-node-red` — Dockerized fixed workflow backed by private Node-RED HTTP execution.
- `examples/server-node-red-agents` — Dockerized fixed two-agent flow, internal checkpoint and addressable chats.
- `examples/client` — typed client, usage sample, and demo runner.
- `scripts` — OpenAPI/catalog/parity generation and validation.
- `docs` — API design, event semantics, research, and route accounting.

For scope and tradeoffs, see [journey fit](docs/journey-fit.md), [research](docs/research.md), and [Archon REST parity](docs/rest-parity.md).

## License

MIT — see [`LICENSE`](LICENSE).
