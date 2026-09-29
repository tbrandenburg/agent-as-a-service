# Lifecycle-observed Node-RED agents example

Run `make install && API_TOKEN=dev-token make demo-node-red-agents` from the root. The demo creates a unique disposable Compose project, discovers its Docker-assigned loopback API port, runs the typed walkthrough and removes its own containers, volumes and project images on exit. Only the API is published on `127.0.0.1` at a dynamic port; Node-RED's admin and HTTP ports and the authenticated callback listener on 3095 stay inside the Compose network. Use distinct `INTERNAL_TOKEN` and `NODE_RED_ADMIN_TOKEN` to override the demo credentials. Node-RED's Admin API accepts only its private bearer credential with `flows.read`/`flows.write`; the managed dispatch entry and finalizer use the separate internal callback credential. Node-RED 5.0.7 installs exactly `@tbrandenburg/node-red-agents@0.4.3` and OpenCode CLI 1.18.33 with `opencode/big-pickle`; outbound model access is needed for the demo.

For persistent, independent pairs, provide different public, callback and Admin tokens for each name; the three tokens within each pair must also be distinct. From the repository root:

```sh
API_TOKEN="${ALPHA_API_TOKEN:?}" INTERNAL_TOKEN="${ALPHA_INTERNAL_TOKEN:?}" NODE_RED_ADMIN_TOKEN="${ALPHA_ADMIN_TOKEN:?}" make start-node-red-agents INSTANCE=alpha
API_TOKEN="${BETA_API_TOKEN:?}" INTERNAL_TOKEN="${BETA_INTERNAL_TOKEN:?}" NODE_RED_ADMIN_TOKEN="${BETA_ADMIN_TOKEN:?}" make start-node-red-agents INSTANCE=beta
make status-node-red-agents INSTANCE=alpha
make status-node-red-agents INSTANCE=beta
make logs-node-red-agents INSTANCE=alpha
make stop-node-red-agents INSTANCE=alpha
make cleanup-node-red-agents INSTANCE=alpha
make cleanup-node-red-agents INSTANCE=beta
```

Set the token variables in your shell or supply them per command; never check credentials into the repository. Names are lowercase letters, digits and hyphens, start with a letter and are at most 40 characters (`demo-*` is reserved). Each `start` prints its project name and current URL; `status` looks up the URL via `docker compose port api 3094`. Use `Authorization: Bearer <that instance's API_TOKEN>` for its API. Starting an existing instance fails instead of replacing it. `stop` removes only the selected project's containers/network and retains its Compose volumes; `cleanup` also deletes those volumes. Restart a stopped instance with the same name and credentials; Docker may assign a new URL. Managed tabs and registry survive `stop`, but run/session histories do not survive an API restart: they are process-local. Separate projects have private service DNS, data volumes and state; scaling a single service within a project is unsupported.

The runtime `settings.js` forwards generic `node.deployed`, `node.closed`, `execution.started`, and `execution.terminal` records to private Express `/observations` using the internal token. Failed terminal records log only the node ID and error category/exit metadata, without prompts, provider messages or credentials. Deployed notices update an internal generation-aware inventory without creating public conversations; missed notices can be repaired by execution starts. The authenticated private `GET /inventory` endpoint displays the current inventory to operators inside Compose. The flow triggers two agents in parallel, joins them, then invokes the writer again. Each trigger carries only `{runId}` in `msg.agentObservation`. Concurrency is four per node; each agent allows one additional attempt for a classified transient provider failure, but no agent or workflow execution deadline is imposed. The image initializes OpenCode's local storage at build time to avoid a first-use migration race between parallel CLI invocations. The HTTP dispatch acknowledges immediately, independently of execution duration. A Catch path reports failures and the joined success path explicitly posts a final outcome to private `/finalize`.

For a controlled long-duration run, start the Compose stack with `CONTROLLED_FIXTURE=true` and post a workflow input. The image then puts a local CLI fixture on the Node-RED runtime's `PATH`; its first writer execution lasts 365 seconds and its remaining executions finish quickly. Leave this switch unset for real OpenCode. The fixture is only for duration/integration checks, never for verifying model behavior.

Start workflow `node-red-demo` with `input: { "text": "..." }`. Its `202` response contains `conversations: []`; each acknowledged execution start adds `{nodeId, conversationId}` to `GET /api/v1/runs/{runId}`. A repeated node ID can have multiple distinct links. To discover retained histories, page through `GET /api/v1/runs`, then fetch each run detail and each linked conversation/messages. Complete messages and ordered conversation events are committed on acknowledged observations; the run remains `running` until the explicit finalizer. A rejected or timed-out start can leave a late attempted-input commit; the failure finalizer retains that history and never fabricates assistant text. A lost finalizer leaves a visibly running run. Restarting the disposable in-memory backend loses inventory, run history, and callback deduplication state.

## Managed workflows

The stable `node-red-demo` workflow is displayed as **Core** and is read-only. `POST /api/v1/workflows`, `PUT /api/v1/workflows/{id}` and `DELETE /api/v1/workflows/{id}` manage individual runnable Node-RED tabs. A managed workflow uses `engine: "node-red"`, `specificationVersion: "managed-v1"` and the following JSON definition (submit the same body to `/api/v1/workflows/validate` for a dry run):

```json
{
  "engine": "node-red",
  "specificationVersion": "managed-v1",
  "specification": {
    "label": "My writer",
    "entry": "writer",
    "finalizer": "writer",
    "configs": [],
    "nodes": [
      { "id": "writer", "type": "agent", "name": "Writer", "wires": [[], []] }
    ]
  }
}
```

Each workflow is exactly one tab. `entry` identifies the first agent and `finalizer` the last successful agent. `wires` are the Node-RED output-port target IDs; the first port carries successes and the second carries errors. The server owns agent runtime/model options, private entry path, correlation, failure Catch and authenticated finalizer. Node IDs must be distinct simple identifiers. Only installed `agent` nodes with `id`, `type`, `name`, `wires` are accepted in this slice; `configs` must be empty. JavaScript functions, credentials, global config, subflows and user-defined endpoints are rejected. The graph owns execution ordering; the finalizer must be reached only after prior agents have finished. There is no general graph semantic verifier or per-run deadline.

Creation returns the Node-RED tab ID and strong `ETag: "v1"`; GET and updates return the current `"vN"`. Optionally use `If-Match: "vN"` on PUT; a stale version returns `412` without deployment. PUT/DELETE reject active runs with `409`; Core mutation returns `403`. Created tabs and the atomic JSON registry are stored in separate per-Compose-project writable volumes and reconciled at startup; missing/mismatched tabs are hidden from the runnable list and return `503` by ID. Removing a workflow does not remove in-memory run/conversation history, but restarting the in-memory API does. `docker compose down -v` removes the disposable definitions. The typed demo uses `DEMO_BASE_URL` and fails nonzero if its real-model managed CRUD/run checks fail.

Inventory does not grant direct invocability. Direct chat, cancellation, resume, SSE, artifacts, projects, interactions, conversation edits/deletion, and run persistence return typed `501` responses. Public conversation IDs never expose private provider session IDs.
