# Node-RED-backed workflow example

This disposable example exposes the unchanged AaaS `/api/v1` contract through the shared Express transport. Node-RED is an implementation detail: its fixed HTTP flow is reachable only inside Docker Compose, never from the host-side client. The server-provided `node-red-demo` workflow is read-only, with `engine: "node-red"` and `specificationVersion: "5.x"` metadata. The compatibility line is not a Node-RED flow-file semantic version; the runtime image is separately pinned to `nodered/node-red:5.0.7`.

```sh
make install
make check
API_TOKEN=dev-token make demo-node-red
```

Requires Docker Engine with Compose v2, Node.js 22.13+, npm, Make, curl, and `ss` on the host. No host Node-RED installation is needed. Port 3093 must be free. The numbered host-side HTTP walkthrough verifies public health/OpenAPI, bearer authentication, workflow discovery and validation, run acceptance and real flow output, ordered lifecycle events, and expected rejection responses. The demo starts an isolated Compose project and removes it on success, failure, or interruption.

For manual startup:

```sh
API_TOKEN=dev-token docker compose -f examples/server-node-red/compose.yaml up --build -d
curl http://127.0.0.1:3093/api/v1/health
docker compose -f examples/server-node-red/compose.yaml down --volumes
```

Authenticated routes require `Authorization: Bearer $API_TOKEN`. Only workflow listing, lookup, narrow validation, run start, run lookup and run event listing are implemented. Workflow mutation and unrelated resources, cancellation, resume, artifacts, interactions, and SSE intentionally retain typed `501 Not Implemented` responses. Runs and event history live in the AaaS server's memory and disappear on restart. Run-scoped ordered events are an **AaaS abstraction**, not a direct mirror of Archon's workflow run route. The private Node-RED `/workflow/demo` endpoint and its payload are not part of the public API. No Node-RED deployment or Admin API is used.
