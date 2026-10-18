# AaaS → A2A structured-dispatch proof of concept

**Experimental, not an A2A-conformant implementation.** Keep this next to the original
`scripts/demo-node-red-apis.sh` and leave the existing backend and REST contract untouched.
The purpose is to test whether all **34 current AaaS operation IDs** can be invoked using
structured data in an A2A `SendMessageRequest` while observing executions with A2A Tasks.

## What it proves (and what it doesn't)

- `bridge.mjs` accepts A2A-shaped HTTP+JSON `POST /message:send` messages, extracts an
  allowlisted `{ operation, parameters?, query?, body?, idempotencyKey?, ifMatch? }` payload
  from `message.parts[].data`, and forwards the corresponding AaaS HTTP call.
- `OPERATIONS` contains all 34 operation IDs from `docs/catalog.md`. The walkthrough compares
  them to the live backend's OpenAPI operation IDs and fails on catalogue drift.
- `startRun` and conversation `sendMessage` produce an A2A-shaped `Task`, reusing the *backend*
  run ID rather than generating a second identity. Native `GET /tasks/{id}` and `POST
  /tasks/{id}:cancel` are supported for known tasks. Backend results are surfaced as A2A
  artifacts; CRUD results are direct A2A messages with JSON data parts.
- `TASK_STATE_INPUT_REQUIRED` represents backend `paused` **only for the purposes of the PoC**;
  this is lossy and must not be codified without further research. An AaaS approval can be
  submitted as a structured `SendMessage` follow-up with the same A2A `taskId`.
- Expected HTTP 409/501 responses are surfaced as errors with `upstreamStatus`, not invented
  successes. This is important when showing unsupported SSE and artifact operations.

**Does not prove:** full generic-A2A-client compatibility, A2A protocol conformance, standard
streaming/subscriptions/push, task history persistence, idempotent message deduplication,
comprehensive Task/Context filters, cancellation race handling, multi-tenant authorization,
safe user-facing natural-language orchestration, or stable cross-restart task IDs.
A tiny rule-based fallback understands `list workflows`, `list projects`, `list runs` and
`status`; it is explicitly **not** System One. The real System One model belongs behind the
same dispatcher in a follow-up spike.

## Run tests without Docker

From repository root:

```bash
node --test scripts/poc-a2a/tests.mjs
```

The test uses an in-memory mock of the current REST backend. It tests all 34 operation
mappings for consistency, authentication forwarding, structured messages, task identity,
status mapping, approval continuation, output artifacts, cancellation and error handling.

## Run against disposable Node-RED

From repository root, with Docker, Node 22+, curl, openssl, timeout and ss installed:

```bash
bash scripts/demo-node-red-a2a-poc.sh
```

This builds the **same** disposable Node-RED agents Compose backend used by the original
`scripts/demo-node-red-apis.sh`, generates fresh API/internal bearer tokens, starts the bridge
on a loopback port, runs the structured-command walkthrough and tears down its containers,
volumes and local image tags. Evidence is saved under `/tmp/opencode/aas-a2a-poc-*//`.

By default, the provider-backed agent turn is skipped to keep the PoC provider-free. To
exercise **all 34** contract operations, including a real agent message, configure the
existing Node-RED provider auth as in the original README and run:

```bash
A2A_DEMO_AGENT=1 bash scripts/demo-node-red-a2a-poc.sh
```

The wrapper requires the repository's installed workspace dependencies and may need
outbound provider access in the full 34-operation mode. No real Docker/provider walkthrough
has been executed as part of preparing this PoC bundle.

## Manual mode with an existing backend

Terminal A:

```bash
AAAS_UPSTREAM_URL=http://127.0.0.1:3094/api/v1 A2A_PORT=3105 \
  node scripts/poc-a2a/bridge.mjs
```

Terminal B (use the same bearer token as the running AaaS backend):

```bash
A2A_URL=http://127.0.0.1:3105 A2A_AUTH_TOKEN="$API_TOKEN" \
  node scripts/poc-a2a/demo.mjs
```

A structured command is packaged inside a standard A2A-shaped request:

```json
{
  "message": {
    "messageId": "message-001",
    "role": "ROLE_USER",
    "parts": [{
      "data": {
        "operation": "listWorkflows",
        "query": {}
      }
    }]
  },
  "configuration": { "returnImmediately": true }
}
```

Example with a resource mutation and backend idempotency forwarding:

```json
{
  "message": {
    "messageId": "message-002",
    "role": "ROLE_USER",
    "parts": [{
      "data": {
        "operation": "createProject",
        "body": { "name": "Alpha" },
        "idempotencyKey": "caller-scoped-operation-key"
      }
    }]
  }
}
```

The mutation example shows the field mapping only: the backend's original idempotency
contract applies *only* to endpoints where it is supported. The bridge does not add
idempotency or authorization policies on its own.

## Core architecture questions exposed by the PoC

1. Does A2A `Task` cover AaaS `Run` lifecycle without lossy `paused` conversions?
2. Should all CRUD operations be expressed as direct A2A Messages, or are long-running
   management mutations better represented by Tasks?
3. How should a structured AaaS command profile be advertised, versioned, validated and
   negotiated using A2A extensions? The demo has no finished extension specification.
4. Is an A2A Task a sufficient replacement for the independently addressable AaaS
   `Interaction` resource and cross-run pending approvals list?
5. Can `Context` and optional session references represent workflow-linked agent activity
   without inventing transcripts or breaking privacy boundaries?
6. Will a full A2A protocol Test Compatibility Kit pass? **Not yet tested**. Do not claim
   native A2A compatibility until it does.

## Desired next step

Replace the experimental manual A2A HTTP parsing with an official A2A SDK/server
implementation, run the A2A Test Compatibility Kit, and add a true System One interpreter
for generic natural-language requests. Keep the original REST API as an independent
regression oracle during the evaluation.

References:
- https://a2a-protocol.org/latest/specification/
- https://github.com/a2aproject/a2a-tck
- https://github.com/tbrandenburg/agent-as-a-service/blob/main/scripts/demo-node-red-apis.sh
