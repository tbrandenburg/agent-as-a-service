# Vercel AI SDK request–response example

A small synchronous example using the existing Express contract transport and a direct OpenAI provider call through the Vercel AI SDK. It implements only `POST /api/v1/runs` and `GET /api/v1/runs/:runId`; other resource operations retain the shared typed 501 response. `POST` waits for generation and returns HTTP 202 with an already-completed run, so no polling is needed.

`OPENAI_API_KEY` is already configured in the implementation environment; use it as-is. The process passes it directly through `@ai-sdk/openai`; this example does not use Vercel AI Gateway or require an `AI_GATEWAY_API_KEY`. `API_TOKEN` is a separate bearer token for local HTTP authentication. Never paste, log, or commit either secret.

```sh
npm ci
export API_TOKEN=dev-token
npm run start:vercel-ai-sdk
```

In another terminal:

```sh
curl -sS -X POST http://127.0.0.1:3096/api/v1/runs \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"target":{"kind":"agent","id":"openai/gpt-6-luna"},"input":"Say hello in one sentence."}'
curl -sS http://127.0.0.1:3096/api/v1/runs/RUN_ID \
  -H 'Authorization: Bearer dev-token'
```

Runs live only in memory and disappear when the server exits. Repeating a POST creates another generation; `Idempotency-Key` is rejected with typed 501. A client timeout or retry does not provide exactly-once billing, and a timeout can occur after the provider has received or billed the request. This is a deliberately small local demo, without persistence, cancellation, streaming, or safe retries.
