#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
for dependency in docker curl jq openssl ss timeout; do
  command -v "$dependency" >/dev/null || { printf 'Missing dependency: %s\n' "$dependency" >&2; exit 1; }
done
docker compose version >/dev/null
if ss -H -ltn | awk '{print $4}' | grep -Eq '(^|:)3095$'; then
  printf 'Port 3095 is occupied; refusing to interrupt an existing service\n' >&2
  exit 1
fi
docker_root="$(docker info --format '{{.DockerRootDir}}')"
available="$(df -Pk "$docker_root" | awk 'NR == 2 {print $4}')"
if [[ ! "$available" =~ ^[0-9]+$ ]] || ((available < 4 * 1024 * 1024)); then
  printf 'Docker storage needs at least 4 GiB free\n' >&2
  exit 1
fi
project="aas-a2a-native-$(openssl rand -hex 8)"
evidence="$(mktemp -d /tmp/opencode/aas-a2a-native-XXXXXXXX)"
API_TOKEN="$(openssl rand -hex 24)"
INTERNAL_TOKEN="$(openssl rand -hex 24)"
A2A_TOKEN="$(openssl rand -hex 24)"
export API_TOKEN INTERNAL_TOKEN A2A_TOKEN DEFAULT_MODEL="${DEFAULT_MODEL:-opencode/big-pickle}"
compose=(docker compose -p "$project" -f "$root/examples/server-node-red-agents/compose.yaml")
a2a_pid=''
step() { printf 'STEP: %s\n' "$*"; }
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$a2a_pid" ]] && kill -0 "$a2a_pid" 2>/dev/null; then
    kill "$a2a_pid" 2>/dev/null || status=1
    wait "$a2a_pid" 2>/dev/null || true
  fi
  timeout 30 "${compose[@]}" logs --no-color > "$evidence/containers.log" 2>&1 || status=1
  timeout 120 "${compose[@]}" down --volumes --remove-orphans --rmi local > "$evidence/cleanup.log" 2>&1 || status=1
  printf 'A2A_NATIVE_RESULT=%s\n' "$([[ "$status" -eq 0 ]] && printf PASS || printf FAIL)"
  printf 'Evidence: %s\n' "$evidence"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ss -H -ltn > "$evidence/listeners-before.log"
step 'Start isolated Node-RED and AaaS backend'
timeout 600 "${compose[@]}" up --build -d > "$evidence/build.log" 2>&1
binding="$(timeout 10 "${compose[@]}" port api 3094)"
[[ "$binding" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { printf 'Unexpected backend bind address\n' >&2; exit 1; }
base="http://$binding/api/v1"
ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if curl --connect-timeout 2 --max-time 2 --fail --silent "$base/health" >/dev/null &&
    timeout 5 "${compose[@]}" exec -T node-red node -e "fetch('http://127.0.0.1:1881/ready',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { printf 'AaaS/Node-RED readiness timed out\n' >&2; exit 1; }

definition='{"name":"Multiply A2A","engine":"node-red","specification":{"entry":"entry","flows":[{"id":"tab","type":"tab","label":"Multiply A2A"},{"id":"entry","z":"tab","type":"link in","x":100,"y":100,"wires":[["multiply"]]},{"id":"multiply","z":"tab","type":"function","x":250,"y":100,"outputs":1,"func":"msg.payload=msg.input.a*msg.input.b;return msg;","wires":[["return"]]},{"id":"return","z":"tab","type":"link out","x":400,"y":100,"mode":"return","links":[],"wires":[]}]}}'
slow='{"name":"Slow A2A cancellation","engine":"node-red","specification":{"entry":"entry","flows":[{"id":"tab","type":"tab","label":"Slow A2A cancellation"},{"id":"entry","z":"tab","type":"link in","x":100,"y":100,"wires":[["slow"]]},{"id":"slow","z":"tab","type":"function","x":250,"y":100,"outputs":1,"func":"setTimeout(()=>{msg.payload=\"done\";node.send(msg)},5000);return;","wires":[["return"]]},{"id":"return","z":"tab","type":"link out","x":400,"y":100,"mode":"return","links":[],"wires":[]}]}}'
workflow_id="$(curl --silent --show-error --fail -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' --data "$definition" "$base/workflows" | jq -er '.id')"
cancel_id="$(curl --silent --show-error --fail -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' --data "$slow" "$base/workflows" | jq -er '.id')"
step 'Start the native SDK-backed A2A agent'
AAS_URL="http://$binding" AAS_TOKEN="$API_TOKEN" A2A_TOKEN="$A2A_TOKEN" PORT=3095 \
  node --import tsx examples/server-a2a/src/main.ts > "$evidence/a2a-server.log" 2>&1 &
a2a_pid=$!
ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if curl --connect-timeout 1 --max-time 2 --fail --silent "http://127.0.0.1:3095/.well-known/agent-card.json" > "$evidence/agent-card.json"; then ready=1; break; fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { printf 'A2A server readiness timed out\n' >&2; exit 1; }
step 'Verify public Agent Card and reject missing/invalid credentials'
for auth_case in missing invalid; do
  auth_headers="$evidence/$auth_case-auth.headers"
  auth_body="$evidence/$auth_case-auth.json"
  if [[ "$auth_case" == missing ]]; then
    status="$(curl --silent --dump-header "$auth_headers" --output "$auth_body" --write-out '%{http_code}' "http://127.0.0.1:3095/tasks/nonexistent")"
  else
    status="$(curl --silent --dump-header "$auth_headers" --output "$auth_body" --write-out '%{http_code}' -H 'Authorization: Bearer invalid-credential' "http://127.0.0.1:3095/tasks/nonexistent")"
  fi
  [[ "$status" == 401 ]] || { printf 'Unauthorized request returned HTTP %s\n' "$status" >&2; exit 1; }
  grep -Eiq '^content-type: application/a2a\+json' "$auth_headers" ||
    { printf 'Unauthorized response used an invalid content type\n' >&2; exit 1; }
  jq -e '.error.code == 401 and .error.status == "UNAUTHENTICATED" and .error.message == "Unauthorized" and .error.details == []' "$auth_body" >/dev/null ||
    { printf 'Unauthorized response used an invalid A2A REST error body\n' >&2; exit 1; }
  printf '%s_auth=401\n' "$auth_case" >> "$evidence/assertions.txt"
done
step 'Use independent SDK ClientFactory for discovery, Task lifecycle, Artifact, cancellation and negative cases'
A2A_URL=http://127.0.0.1:3095 A2A_TOKEN="$A2A_TOKEN" A2A_WORKFLOW_ID="$workflow_id" A2A_CANCEL_WORKFLOW_ID="$cancel_id" \
  node --import tsx examples/server-a2a/src/client.ts > "$evidence/client.log" 2>&1
cat "$evidence/client.log"
step 'Run official pinned HTTP+JSON mandatory TCK'
 tck_status=0
if bash scripts/a2a-tck.sh http://127.0.0.1:3095 > "$evidence/tck-runner.log" 2>&1; then
  cat "$evidence/tck-runner.log"
else
  tck_status=$?
  cat "$evidence/tck-runner.log"
  printf 'TCK failed with status %s; see preserved logs and report\n' "$tck_status" >&2
fi
step 'Run workspace, contract and original regression checks'
regression_status=0
if make check > "$evidence/regressions.log" 2>&1; then
  cat "$evidence/regressions.log"
else
  regression_status=$?
  cat "$evidence/regressions.log"
  printf 'Regression checks failed with status %s\n' "$regression_status" >&2
fi
if [[ "$tck_status" -ne 0 || "$regression_status" -ne 0 ]]; then
  printf 'TCK_RESULT=%s REGRESSION_RESULT=%s\n' \
    "$([[ "$tck_status" -eq 0 ]] && printf PASS || printf FAIL)" \
    "$([[ "$regression_status" -eq 0 ]] && printf PASS || printf FAIL)" >&2
  exit 1
fi
printf 'PASS: A2A Card, auth, workflow discovery, numeric Artifact, Task retrieval/cancel, TCK and regressions\n'
