# OpenCode-backed server example

A deliberately small, in-memory Express backend that runs one real `opencode run` process per conversation message. It is an example of the REST contract, not a hosted service.

## Requirements and configuration

- Node.js 22.13+, npm, and a working `opencode` CLI installation.
- OpenCode must be authenticated with a provider that can answer prompts. The default model is `opencode/big-pickle`; set `OPENCODE_MODEL` to a model available in your installation if needed.
- `API_TOKEN` configures bearer authentication (default `dev-token`).
- `OPENCODE_DIR` selects the process working directory (default current directory) and must exist.
- `OPENCODE_TIMEOUT_MS` sets the finite CLI timeout (default `300000`).
- `HOST` and `PORT` configure the server (defaults `127.0.0.1:3092`, distinct from the Express example's port).

The server owns the CLI cwd and model. HTTP requests cannot choose an engine, agent, model, working directory, or engine options. Only plain text conversation messages are forwarded; content parts are rejected. Conversation and provider-session state exists only in memory and is lost when the process exits. Other contract operations use the typed 501 fallback.

## Run

```sh
make install
make demo-opencode
```

`make demo-opencode` starts an ephemeral authenticated HTTP server, creates a conversation, submits a prompt, reads the accepted run immediately, polls for the real assistant response and ordered events, then asks for a distinctive first-turn marker and verifies the returned session ID confirms continuation. To run a persistent server instead:

```sh
API_TOKEN=dev-token make start-opencode
```

`make demo-express` remains the simulated walkthrough and does not require OpenCode.
