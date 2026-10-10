# @tbrandenburg/node-red-host

Disposable worker host for an independently installed Node-RED runtime. It exposes the existing private execution protocol on port 1881 and runs each accepted attempt in a short-lived embedded Node-RED process.

Install this package into the host deployment alongside its Node-RED installation and palette modules. The package intentionally has no Node-RED dependency.

Required configuration: `INTERNAL_TOKEN`, `WORKER_CALLBACK_URL`, `PROJECTS_ROOT`, and `GLOBAL_WORK_ROOT`. `NODE_RED_MODULES` identifies the shared `node_modules` directory containing both `node-red` and `express`; in the official Node-RED image it defaults to `/usr/src/node-red/node_modules`. `PALETTE_NODE_MODULES` defaults to `/data/node_modules` and is linked into each worker's temporary user directory.

Optional configuration: `MAX_WORKERS` (4), `WORKER_TIMEOUT_MS` (450000), `PORT` (1881), `HOST` (`0.0.0.0`), and `NODE_RED_WORKER_METRICS` (`false`). The configured project/global roots must exist and be mounted in the host container.

Run with `aaas-node-red-host`. The package uses stock Node-RED embedding (`RED.init` / `RED.start`) and does not install palette nodes or restart failed executions.

<!-- Temporary host-only workflow trigger verification. -->
