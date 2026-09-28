# OpenCode-backed server example

A deliberately small, in-memory Express backend that exposes the repository's complete engine-neutral REST contract and runs one real `opencode run` process per conversation message. It is an example, not a hosted service. Implemented conversation/message/run/event operations use the OpenCode CLI; unsupported resource operations retain typed `501` responses.

## Requirements and model

- Docker Engine with Compose v2, Make, curl, Node.js 22.13+, and npm for the host-side demo client.
- The image pins `opencode-ai` 1.18.33 and fixes the model to `opencode/big-pickle`. No host OpenCode installation, OpenCode login, `auth.json`, or provider API key is used. The CLI reaches the hosted model over outbound network access. OpenCode documents Big Pickle as free for a limited time; availability and terms may change.
- `API_TOKEN` is the HTTP API bearer token, separate from provider authentication. Supply it at runtime (`dev-token` is the local Compose default); the Docker image does not contain it.

## Docker walkthrough

```sh
make install
API_TOKEN=dev-token make demo-opencode
```

`make demo-opencode` builds from the repository root, starts an isolated Compose project, waits up to 60 seconds for readiness, runs the host HTTP client against the published `http://127.0.0.1:3092` endpoint, then removes that project on success, error, or interruption. Its numbered walkthrough discovers the public health/OpenAPI routes, authenticates to the HTTP contract, opens a conversation, gets substantive real Big Pickle advice, verifies idempotency and ordered run events, then confirms a second-turn reply recalls context in a resumed session. Missing/wrong bearer tokens and unsupported operations are shown as **expected rejection checks**; the walkthrough ends with a success summary. Projects, workflows, approvals, and artifacts remain unimplemented in this example; use `make demo-express` for that simulated journey. Port 3092 must be free; if it is occupied, stop only the service that owns it before retrying. The host demo needs Node/npm dependencies from `make install`, but never the host OpenCode CLI.

To start the service for manual requests and stop it:

```sh
API_TOKEN=dev-token docker compose -f examples/server-opencode/compose.yaml up --build -d
curl http://127.0.0.1:3092/api/v1/health
curl http://127.0.0.1:3092/api/v1/openapi.json
docker compose -f examples/server-opencode/compose.yaml down
```

Authenticated routes use `Authorization: Bearer $API_TOKEN`. Compose publishes only on localhost, fixes the container listener to `0.0.0.0:3092`, stores the OpenCode working directory at `/workspace`, and starts Node in the foreground with a tiny init to reap CLI children. It does not mount a host project or OpenCode configuration. For intentional workspace use, add a bind mount at `/workspace`; that workspace is writable by the non-root `node` user.

Conversation and OpenCode session mapping is in memory. Restarting the HTTP backend loses conversations and their mapping even if OpenCode session files happen to persist in the container. Stopping the container terminates active requests and their CLI children; the init process reaps those children. The demo container has no persistent volume, so its filesystem state is discarded at shutdown.

`make demo-express` remains the independent simulated walkthrough and does not require Docker or OpenCode.
