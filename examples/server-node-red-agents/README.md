# Native Node-RED workflows and observed agents

This example stores native Node-RED definitions and runs each accepted invocation in a private, bounded Node-RED worker. Workflow CRUD needs only the atomic JSON registry; there is no shared editor/definition runtime or Admin deployment.

## Run

From the repository root:

```sh
make install
DEFAULT_MODEL=github-copilot/gpt-6-luna API_TOKEN=dev-token make demo-node-red-agents
```

The disposable demo checks Docker storage (at least 4 GiB free), builds a unique Compose project, discovers its dynamic loopback API port, runs native HTTP acceptance and real-provider/session acceptance, then removes its own containers, volumes and project images. Only the public API is published; the supervisor and authenticated callback listener stay on the Compose network. Node-RED 5.0.7 installs `@tbrandenburg/node-red-agents@0.4.3` and OpenCode CLI 1.18.33. The native host Link Call implementation is extracted from the integrity-verified `@tbrandenburg/node-red-cli@0.2.18` tarball at build time, avoiding its unused dependency tree. Extraction removes the CLI's single-tab/static-wire preflight, which cannot follow native cross-tab Links/subflows; invocation, first-return handling and cleanup retain upstream semantics. Runtime lookup and bounded timeout own invalid-target failures.

The optional gitignored root `.home/` seed is mounted read-only and copied into the Node-RED container user's home on startup, including hidden files. For authenticated providers, place trusted home-relative configuration there, such as `.home/.config/opencode/opencode.jsonc` and `.home/.local/share/opencode/auth.json`. The API never mounts this seed; container changes never sync back. Never display credential contents. `opencode auth list` inside your instance lists provider names without credentials. OpenCode storage is initialized during image build.

`DEFAULT_MODEL=provider/model` selects the model for environment-configured agent nodes; omission defaults to `opencode/big-pickle`, and empty values are rejected. Provider acceptance uses `github-copilot/gpt-6-luna`. Recreate the instance after changing the model.

Persistent independent instances require distinct public and internal tokens:

```sh
DEFAULT_MODEL=github-copilot/gpt-6-luna API_TOKEN="${PUBLIC_TOKEN:?}" INTERNAL_TOKEN="${CALLBACK_TOKEN:?}" make spawn-node-red-agents
DEFAULT_MODEL=github-copilot/gpt-6-luna API_TOKEN="${PUBLIC_TOKEN:?}" INTERNAL_TOKEN="${CALLBACK_TOKEN:?}" make start-node-red-agents INSTANCE=alpha
make status-node-red-agents INSTANCE=alpha
make logs-node-red-agents INSTANCE=alpha
make stop-node-red-agents INSTANCE=alpha
make cleanup-node-red-agents INSTANCE=alpha
```

Names start with a lowercase letter, use lowercase letters/digits/hyphens and have at most 40 characters; `demo-*` is reserved. Spawn checks project-name collisions and prints lifecycle commands. Start refuses an existing running instance. Stop retains volumes; cleanup removes the selected project's volumes. Restart may assign a new API URL. Workflow definitions and project registries persist, but run/conversation histories and session mappings are in-memory and disappear when the API restarts.

## Native workflow API

Submit complete editor flow JSON with the explicit public Link In entry:

```json
{
  "name": "Multiply",
  "engine": "node-red",
  "specification": {
    "entry": "entry",
    "flows": [
      { "id": "main", "type": "tab", "label": "Main" },
      { "id": "entry", "z": "main", "type": "link in", "x": 100, "y": 100, "wires": [["multiply"]] },
      { "id": "multiply", "z": "main", "type": "function", "x": 250, "y": 100, "outputs": 1, "func": "msg.payload=msg.input.a*msg.input.b;return msg;", "wires": [["return"]] },
      { "id": "return", "z": "main", "type": "link out", "x": 400, "y": 100, "mode": "return", "links": [] }
    ]
  }
}
```

`POST /api/v1/workflows/validate` validates only `engine`, an object specification, nonempty `entry`, a nonempty object array `flows`, and exactly one matching entry whose type is `link in`. Node-RED owns graph and node semantics. Multiple tabs/Link In nodes, subflows, config nodes, arbitrary installed/community nodes and startup/background nodes are supported without a node-type policy. Workflow authors are trusted. Complete editor exports do not carry separate Node-RED credential state; environment-backed/native external configuration remains available.

Create returns `201`, an opaque AaaS workflow ID independent of tab IDs, and strong `ETag: "v1"`. GET and PUT return the current `"vN"`; optional `If-Match` on PUT rejects stale versions with `412`. Update/delete succeed while older runs are active. Acceptance clones the exact native definition, records `run.workflowVersion`, and writes the complete `flows` array unchanged to the worker: no generated nodes or ID/`z`/wire rewriting. Workflow deletion leaves historical runs readable until explicit run deletion or API restart.

Start with:

```json
{
  "target": { "kind": "workflow", "id": "<created-id>" },
  "input": { "a": 13.75, "b": -8 }
}
```

`202` means the run is immediately readable. The host invokes the selected native Link In with unchanged `msg.input` and `msg.agentObservation: {runId}`. `msg.payload` is independent working state. A native Link Out(return) completes the upstream Link Call; its first-return semantics remain authoritative. Only returned `msg.payload` becomes public output. JSON strings, finite numbers, booleans, null, objects and arrays preserve their types (the example returns numeric `-110`). Buffer, function, undefined, cycles and other non-JSON payloads explicitly fail; they are never stringified/coerced. Returned lifecycle fields do not control AaaS status or identity.

Runtime load errors, missing/disabled entries, unreachable returns, node errors and timeouts become failed runs asynchronously. Readiness is a host route available after `flows:started`, outside user flow JSON. No agent conversation is needed for a native non-agent workflow.

## Acceptance

### Timed contract smoke

```sh
make smoke-node-red-agents
```

Requires installed workspace dependencies, Docker Compose, curl, Make and `ss`, plus at least 4 GiB free in Docker storage. Builds may require registry/npm access; workflow execution needs no model access or provider credentials. The command generates distinct temporary tokens and a fresh instance name, uses the existing instance startup/readiness checks, and calls the typed HTTP contract client to validate, create and retrieve a native `Link In → Function → Link Out(return)` workflow. It executes once with `{a:13.75,b:-8}`, requires immediate run readability and completed numeric output `-110`, then removes its own containers, volumes and project image tags. Other instances are untouched.

Rejection, failed/cancelled runs, timeout, incorrect output or cleanup failure returns a nonzero exit status. Each HTTP request is bounded to 30 seconds; polling is bounded to 60 seconds, and lifecycle commands to 300 seconds. Failure and interruption attempt cleanup; instance logs are printed on failure.

The final `SMOKE_RESULT` line contains UTC start/finish timestamps, workflow/run IDs, input/output, status and monotonic durations in milliseconds:

| Field | Boundary |
| --- | --- |
| `preparationMs` | Docker storage and project collision checks. |
| `spawnMs` | Existing instance start command, including Docker build/cache checks and API/private supervisor readiness. Not a cold-build benchmark. |
| `workflowValidationMs`, `workflowCreationMs`, `workflowRetrievalMs` | Corresponding HTTP request through complete response receipt. |
| `runAcceptanceMs` | POST run through receipt of `202`. |
| `executionMs` | POST run through retrieval and verification of completed output; includes acceptance, worker startup and 50 ms polling. |
| `stepsCompleteMs` | Command start through verified result, excluding cleanup; omitted on failure. |
| `cleanupMs` | Removing owned containers, volumes, network and image tags. |
| `overallMs` | Command start through cleanup attempt. |

`runAcceptanceMs` is included in `executionMs`; these fields must not be summed. `spawnIncludesBuild` is always true. Timings measure client-observed execution rather than multiplication CPU time.

```sh
make test-native-node-red-agents
bash examples/server-node-red-agents/native-acceptance.sh
DEFAULT_MODEL=github-copilot/gpt-6-luna API_TOKEN=dev-token make demo-node-red-agents
```

The provider-free HTTP script builds production images without a home seed and records statuses, ETags, opaque workflow/run IDs, versions and typed outputs. It exercises multitab/cross-tab Links/subflows, Function/Change/Switch/startup nodes, generic JSON, runtime failures and non-JSON results, stale updates, concurrent mutation snapshots, deletion and history. Run-control acceptance cancels an observed slow Function and an immediately accepted run, verifies unconfirmed observations and worker absence after the original delay, checks released capacity, resume conflicts, active/terminal deletion and identical accepted-start replay after deletion. The pinned runtime suite checks native Link Call lookup/timeout, host authentication/async acceptance, exact snapshots, output rejection, crash/shutdown, observation and deterministic stop/start capacity races. Exec/File/custom-node cwd proof stays in `/examples/server-node-red-agents/node-red/fixtures/cwd.json`.

The provider demo resolves built-in Core, verifies its read-only guards, overlapping native runs, orchestrator observations, readable user/assistant messages, project cwd and retained history after terminal-run deletion. Conversation continuation is deferred to #51. The separate `make demo-node-red` example remains independent.

## Observation and worker lifecycle

`settings.js` forwards `node.deployed`, `node.closed`, `execution.started` and `execution.terminal` to private `/observations`. Failed terminals log sanitized node/error categories without prompts or credentials. Acknowledged starts create public conversation/message links; successful terminals commit assistant messages and private session mappings. Poll `/runs`, run detail, linked conversations and messages to discover histories.

Worker `onReceive`, `onComplete` and `onSend` hooks create opaque per-invocation execution IDs with `key` equal to native node ID. Received means `running`; matching `done()`/`done(error)` yields completed/failed. Unmatched or ambiguous completions end `unconfirmed`, not fabricated success. Source emissions produce `node.sent`; bounded callback interruption produces `observation.incomplete`. Payloads are not included in generic observation events. The host alone finalizes runs.

`MAX_WORKERS` bounds active workers (default 4, integer 1–32). Fully active capacity returns `503 workers_busy`; turnover waits up to 20 seconds for cleanup, then fails with `worker_capacity_timeout` if necessary. Workers have separate ports/userDirs/process groups and a 450-second lifetime; cleanup terminates owned agent subprocesses too. Flow/global context is per-run unless nodes use external persistence.

Enable native metrics with `NODE_RED_WORKER_METRICS=true`. Logs retain Node-RED fields under `[worker runId=<id>]`; receive/send indicates activity, not completion. Inspect your project's logs and `/runs/<id>/events?after=0` when diagnosing failures. Metrics add no public API fields.

## Projects and Core conversations

Project provisioning supports `{}`/empty, clone from public HTTPS GitHub URLs, and registration of existing directories under `/data/projects`. Optional safe `folderName` selects an unused directory independently of display name. Legacy `repositoryUrl`/`localPath` forms remain accepted. Rename changes only display name; delete unregisters after active runs finish and never erases files. Missing directories are unavailable to new runs; symlink escapes and paths outside the project root are rejected.

Only explicit `run.projectId` chooses cwd; omission uses `/data/agent-work` and `run.projectId: null`. Workflow metadata/conversation IDs do not select a directory. Same-project runs may overlap. File/Exec/process-relative nodes inherit worker cwd; absolute paths and node-specific bases do not. This is process isolation, not filesystem isolation. A workflow-created worktree does not change cwd.

Primary runs support workflow targets only. Built-in `{kind:"workflow",id:"core"}` is version 1, named Core and exposed exactly once by workflow list/get with `readOnly:true`; update/delete return `403 workflow_read_only`. Core is server-owned and never persisted in the user registry. Its native flow is `Link In → orchestrator → Link Out(return)`, executed through the same snapshot/worker/Link Call path as user workflows. The agent reads typed `msg.input.text`, selects its model from `DEFAULT_MODEL`, and has no node cwd override. Only agent output 1 returns success; output 2 progress is unconnected to the return boundary.

Start Core with `{"target":{"kind":"workflow","id":"core"},"input":{"text":"Reply briefly"}}`. A fresh run needs no conversation; acknowledged agent execution creates one with `target: {kind:"agent",id:"orchestrator"}` metadata. Unknown workflows return `404`; other target kinds return `501 unsupported_target_kind` without dispatch. `startRun` with `conversationId` returns `501 conversation_continuation_unsupported`. #51 will add established-session continuation through sendMessage; it will not resume or rerun Core/the originating workflow. Private provider sessions are captured by ordinary observations and never exposed as public conversation IDs.

For extended project CRUD/capacity/provider acceptance, create `/data/projects/existing-fixture` in your own fresh instance, then run `DEFAULT_MODEL=github-copilot/gpt-6-luna DEMO_COMPOSE_PROJECT=<project> DEMO_BASE_URL=<url> API_TOKEN=<token> node --import tsx examples/server-node-red-agents/src/projects-demo.ts`.

## Run controls

`POST /api/v1/runs/:runId/cancel` claims a queued/running/paused run, closes unfinished node observations as `unconfirmed`, and waits for its isolated worker/process group to stop before returning `200 {run}` with status `cancelled`. Pending launches are stopped too; late finalizers, observations and expected exits cannot overwrite the claim. An optional `{reason}` is recorded in `run.cancelled` event data, not `run.error`. Unknown runs return `404`; terminal runs return `409 run_not_active`. An uncertain shutdown returns `503 worker_stop_failed`, retains the cancellation claim and active capacity, and permits retry; it never reports successful cancellation while execution may remain live.

`POST /api/v1/runs/:runId/resume` is implemented but current runs return `409 run_not_resumable` (`404` if unknown). No workflow is replayed. A future suspension producer may supply an executor-owned opaque continuation for a paused run; the runtime would continue the same public run without AaaS interpreting the graph. Future conversation continuation is independent of run resume.

`DELETE /api/v1/runs/:runId` accepts completed/failed/rejected/cancelled runs and removes their public detail, events and run-scoped bookkeeping. Active runs return `409 run_active`; unknown/deleted runs return `404`. Conversation/messages, provider sessions, project files and workflow definitions survive. Accepted `Idempotency-Key` responses remain identical for at least 24 hours, even after deletion; their historical run ID then returns `404` rather than dispatching duplicate work. Histories/cache are in-memory and restart limitations still apply.

Direct chat writes, SSE, artifacts, interactions, conversation editing and run persistence return typed `501`. Inventory does not grant direct invocability.

Primary sources: [native complete flow representation](https://nodered.org/docs/api/admin/types), [complete editor export](https://nodered.org/docs/user-guide/editor/workspace/import-export), [Link Call semantics](https://nodered.org/docs/user-guide/writing-functions#calling-link-nodes).
