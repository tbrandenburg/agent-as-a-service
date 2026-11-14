# Native A2A management agent (experimental)

This isolated example exposes workflow discovery/execution over official A2A v1 HTTP+JSON. It uses `@a2a-js/sdk@1.3.0`: `DefaultRequestHandler` owns protocol routing and its in-memory SDK `TaskStore` owns task retrieval; `AgentExecutor` adapts backend operations and the SDK Express `restHandler` and `agentCardHandler` host the standard interface. An independent demonstration client uses `ClientFactory` with `RestTransportFactory`. This keeps A2A serialization, version handling, routes and task ownership in the official SDK rather than duplicating a protocol implementation.

## Run

Requires Node.js 22.13+, installed workspace dependencies, and a running AaaS backend exposing the routes in `docs/catalog.md`.

```sh
npm ci
A2A_TOKEN=local-a2a-token \
AAS_URL=http://127.0.0.1:3094 \
AAS_TOKEN=your-backend-token \
npm run start:a2a
```

The server listens on loopback port 3095 by default. Its public Agent Card is `http://127.0.0.1:3095/.well-known/agent-card.json`. Every A2A operation requires `Authorization: Bearer $A2A_TOKEN`; discovery is public. The AaaS backend token is only sent by the server to the configured backend. For independent caller scoping, optional `A2A_TOKENS='principal:secret,other:another-secret'` adds named bearer identities; never put this value in logs or evidence.

```sh
A2A_URL=http://127.0.0.1:3095 A2A_TOKEN=local-a2a-token npm run demo:a2a-client
```

The client independently discovers the card and sends `list workflows` via the SDK. Structured commands use a single A2A `data` part:

```json
{
  "operation": "workflows.execute",
  "parameters": {
    "workflowId": "workflow-id",
    "input": { "a": 13.75, "b": -8 }
  }
}
```

`workflows.list` returns a structured workflow catalogue. Execution returns an SDK-managed Task, which can be retrieved using standard Get Task; successful final JSON output appears as a structured Artifact. Cancel Task maps to the existing backend cancel operation. `paused` backend Runs are reported as unsupported/failed rather than mislabeled as A2A human-input requests.

## Tests and conformance

```sh
npm run test:a2a
npm run format:check
npm run lint
npm run typecheck
```

The official TCK was pinned to `a2aproject/a2a-tck@104a7b4ae0d83f65c075e3793e322953a830eaba`. That revision's `pyproject.toml` requires Python `>=3.15`; the runner asks `uv` to provision that version. Its committed lock selects `grpcio` 1.78.0, which builds from source for Python 3.15 and can take a long time, so the runner refreshes only the TCK checkout's `grpcio` resolution to the wheel-compatible current version and records both that version and the resulting lockfile SHA-256. This modifies no tracked repository files or TCK source. Run `A2A_TOKEN=local-a2a-token bash scripts/a2a-tck.sh http://127.0.0.1:3095`. The pinned TCK does not accept configured request credentials. The runner therefore starts a loopback-only test proxy which adds the test bearer credential and redirects the discovered card's interface URL through itself; it preserves protocol requests and never logs credentials. TCK output, exit status, dependency resolution and generated compatibility report are stored under `/tmp/opencode/`.

Observed mandatory-suite result on 2026-11-14: **46 tests passed, 7 failed, 176 skipped, 34 deselected**, representing four distinct failed MUST requirement IDs (`DM-ART-001`, `DM-MSG-001`, `HTTP_JSON-ERR-001`, and `CORE-SEND-003`). The TCK requirement summary reports 40 MUST requirements passed and 4 failed. `DM-ART-001`'s text/file/URL/data variants and `DM-MSG-001`'s generic sample message assert sample-agent content, outside this management agent's advertised deterministic command behavior; the agent's own data Artifact is verified by the independent client. `CORE-SEND-003`'s pinned TCK requirement describes an unsupported-media error but omits the `expected_error` binding, so the runner rejects the SDK's correct 400 response. `HTTP_JSON-ERR-001` expects `application/json`; the official SDK returns `application/a2a+json` for A2A REST errors, a known TCK/spec-version mismatch tracked in [a2a-tck #240](https://github.com/a2aproject/a2a-tck/issues/240). The complete report is evidence, not a passing conformance claim; this example should remain experimental/draft until these failures are resolved or formally established as inapplicable.

## Limits

This is a PoC, not production authorization or durable execution. The fallback single configured bearer token identifies one caller; optional `A2A_TOKENS` maps static credentials to SDK task-store principals, not a general identity provider. Tasks and Task-to-Run associations disappear on restart. Backend polling is bounded and retries failed status reads within that bound; if the backend remains unavailable or active past the limit, the Task stays working and cancelable, but no later completion will be observed by that server process. Streaming, push notifications, persistence, general natural language, and human approval continuation are not advertised or implemented. The backend is still the authority for execution and cancellation. No AaaS contract or existing REST behavior changes.
