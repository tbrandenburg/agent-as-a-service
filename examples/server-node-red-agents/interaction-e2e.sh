#!/usr/bin/env bash
set -euo pipefail
project="aas-interaction-${RANDOM}-${RANDOM}"
export COMPOSE_PROJECT_NAME="$project"
export API_TOKEN="$(openssl rand -hex 24)"
export INTERNAL_TOKEN="$(openssl rand -hex 24)"
export MAX_WORKERS=1
evidence="${EVIDENCE_DIR:-/tmp/opencode/$project}"
ls /tmp/opencode >/dev/null
mkdir -p "$evidence"
compose=(docker compose -p "$project" -f examples/server-node-red-agents/compose.yaml -f examples/server-node-red-agents/node-red/fixtures/compose.native.yaml)
cleanup() {
  status=$?
  printf 'Acceptance exit status: %s\n' "$status"
  trap - EXIT
  "${compose[@]}" logs --no-color > "$evidence/containers.log" 2>&1 || status=1
  "${compose[@]}" down --volumes --remove-orphans --rmi local > "$evidence/cleanup.log" 2>&1 || status=1
  printf 'Evidence: %s\n' "$evidence"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Mandatory inspection; the API publishes an ephemeral localhost port.
ss -H -ltn > "$evidence/listeners-before.log"
df -h /tmp > "$evidence/disk.log"
docker system df >> "$evidence/disk.log"
"${compose[@]}" build > "$evidence/build.log" 2>&1
"${compose[@]}" up -d > "$evidence/start.log" 2>&1
address=""
for attempt in $(seq 1 20); do
  address="$("${compose[@]}" port api 3094 2>> "$evidence/start.log")" || true
  if [ -n "$address" ]; then break; fi
  sleep 1
done
if [ -z "$address" ]; then printf '%s\n' 'API published port was not available'; exit 1; fi
export DEMO_BASE_URL="http://$address"
ready=0
for attempt in $(seq 1 90); do
  if curl --fail --silent "$DEMO_BASE_URL/api/v1/health" >/dev/null && "${compose[@]}" exec -T node-red node -e "fetch('http://127.0.0.1:1881/ready',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" -eq 1
node --import tsx examples/server-node-red-agents/src/interaction-e2e.ts | tee "$evidence/http.log"
"${compose[@]}" logs --no-color node-red > "$evidence/attempts.log"
EVIDENCE="$evidence/attempts.log" node --input-type=module -e '
import {readFileSync} from "node:fs";
import assert from "node:assert/strict";
const records=readFileSync(process.env.EVIDENCE,"utf8").split("\n").flatMap(line=>{const start=line.indexOf("{\"type\":\"attempt.");if(start<0)return [];return [JSON.parse(line.slice(start))]});
const starts=records.filter(item=>item.type==="attempt.started");
const stops=records.filter(item=>item.type==="attempt.stopped");
assert.equal(starts.length,3);assert.equal(stops.length,3);assert.equal(new Set(starts.map(item=>item.attemptId)).size,3);assert.equal(new Set(starts.map(item=>item.runId)).size,2);
for(const start of starts)assert.ok(stops.some(stop=>stop.attemptId===start.attemptId));
console.log(JSON.stringify({evidence:"three distinct private attempts, two public runs, every worker stopped",records}));
' | tee "$evidence/lifecycle.log"
