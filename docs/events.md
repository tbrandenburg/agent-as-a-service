# Run events: poll or stream

`GET /api/v1/runs/{runId}/events?after=0&limit=100` returns ordered event objects with `sequence`, `type`, optional `data` and `executionId`, and a timestamp. Pass the last sequence as `after` to fetch later events.

`GET /api/v1/runs/{runId}/events/stream` returns `text/event-stream` when supported. Each event uses `id: <sequence>`, `event: <type>` and `data: <JSON event>`; the JSON follows the same event schema as the polling endpoint. The client can reconnect with `Last-Event-ID: <last-sequence>`; a server should replay subsequent events before live delivery. If replay is unavailable, the client can reconcile with the polling endpoint. Inspect the run for terminal status and output/error. Event types remain extensible and do not prescribe a workflow engine vocabulary.

```sh
curl -N -H 'Authorization: Bearer dev-token' \
  -H 'Last-Event-ID: 12' \
  http://127.0.0.1:3091/api/v1/runs/RUN_ID/events/stream
```

The included example backend returns `501` for the streaming route. An implementation must authorize the run before starting an SSE response, then handle disconnects and replay according to its event store.
