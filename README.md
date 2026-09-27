# Agent as a Service

**An engine-neutral REST contract for agent projects, conversations, workflows, runs, events, artifacts, and human decisions.**

Use it as a typed API specification when building an agent backend or client. The contract defines the HTTP surface independently of any provider, database, or server framework.

[OpenAPI](openapi.json) · [Endpoint catalog](docs/catalog.md) · [Design decisions](docs/design.md) · [MIT License](LICENSE)

> This repository is a contract and example implementation, not a hosted service or a ready-to-run agent platform. The standard Express example returns `501 Not Implemented` for resource operations. The demo backend is in-memory and simulated.

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
- Optional idempotency keys for safe retries and ETags for workflow updates.
- Ordered run and conversation events, including resumable SSE semantics.
- Human decisions for runs that need approval or feedback.
- Generated OpenAPI, with portable event payloads described in extensions.

The API contract is the source of truth. The Express server, typed client, and demo are examples that can be replaced independently.

## Try it locally

Requirements: Node.js 22.13 or newer, npm, and Make.

```sh
make install
make generate
make check
make demo
```

`make demo` runs a simulated end-to-end workflow against a temporary in-memory Express server. It exercises project creation, chat, a workflow run, human approval, events, and an artifact; all state disappears when the process exits.

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
| `make check` | Run typecheck, tests, OpenAPI/parity validation, and formatting checks. |
| `make demo` | Run the simulated HTTP walkthrough. |
| `make start` / `make dev` | Start the Express example normally or in watch mode. |
| `make help` | List the main targets. |

The complete command list is in [`Makefile`](Makefile). After changing the contract, run `make generate` before `make check` and commit the generated files.

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
- `examples/client` — typed client, usage sample, and demo runner.
- `scripts` — OpenAPI/catalog/parity generation and validation.
- `docs` — API design, event semantics, research, and route accounting.

For scope and tradeoffs, see [journey fit](docs/journey-fit.md), [research](docs/research.md), and [Archon REST parity](docs/rest-parity.md).

## License

MIT — see [`LICENSE`](LICENSE).
