#!/usr/bin/env bash
# Disposable public-contract walkthrough; never prints bearer credentials.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
for dependency in docker curl jq openssl timeout ss; do
  command -v "$dependency" >/dev/null || { printf 'Missing dependency: %s\n' "$dependency" >&2; exit 1; }
done
docker compose version >/dev/null
export DEFAULT_MODEL="${DEFAULT_MODEL-github-copilot/gpt-6-luna}"
API_TOKEN="$(openssl rand -hex 24)"
INTERNAL_TOKEN="$(openssl rand -hex 24)"
export API_TOKEN INTERNAL_TOKEN
run_timeout="${RUN_TIMEOUT:-180}"
[[ "$run_timeout" =~ ^[1-9][0-9]*$ ]] || { printf 'RUN_TIMEOUT must be positive integer seconds\n' >&2; exit 2; }
project="aas-api-demo-$(openssl rand -hex 8)"
evidence="$(mktemp -d /tmp/opencode/aas-api-demo-XXXXXXXX)"
compose=(docker compose -p "$project" -f "$root/examples/server-node-red-agents/compose.yaml")
blue='' green='' reset=''
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then blue=$'\033[1;36m'; green=$'\033[1;32m'; reset=$'\033[0m'; fi
section() { printf '\n%s━━ %s ━━%s\n' "$blue" "$*" "$reset"; }
cleanup() {
  local status=$?
  trap - EXIT
  section 'Shutdown: remove demo containers, volumes, network and image tags'
  timeout 30 "${compose[@]}" logs --no-color > "$evidence/containers.log" 2>&1 || status=1
  if ! timeout 120 "${compose[@]}" down --volumes --remove-orphans --rmi local > "$evidence/cleanup.log" 2>&1; then
    cat "$evidence/cleanup.log" >&2
    status=1
  fi
  if [[ "$status" -eq 0 ]]; then printf '%sPASS: walkthrough and teardown%s\n' "$green" "$reset";
  else printf 'FAIL: walkthrough or teardown (exit %s); see evidence logs\n' "$status" >&2; fi
  printf 'Compose project: %s\nEvidence: %s\n' "$project" "$evidence"
  exit "$status"
}
# Check storage before taking ownership of a disposable Compose project.
docker_root="$(docker info --format '{{.DockerRootDir}}')"
available="$(df -Pk "$docker_root" | awk 'NR == 2 {print $4}')"
if [[ ! "$available" =~ ^[0-9]+$ ]] || ((available < 4 * 1024 * 1024)); then
  printf 'Docker storage needs at least 4 GiB free\n' >&2
  exit 1
fi
ss -H -ltn > "$evidence/listeners-before.log"
mkdir -p "$root/.home"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
section "Start private Node-RED + public REST API ($project)"
printf 'Model: %s | build logs: %s/build.log\n' "$DEFAULT_MODEL" "$evidence"
timeout 600 "${compose[@]}" up --build -d > "$evidence/build.log" 2>&1 || { tail -60 "$evidence/build.log" >&2; exit 1; }
binding="$(timeout 10 "${compose[@]}" port api 3094)"
[[ "$binding" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { printf 'Unexpected port binding: %s\n' "$binding" >&2; exit 1; }
base="http://$binding/api/v1"
ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if curl --max-time 2 --fail --silent "$base/health" >/dev/null &&
    timeout 5 "${compose[@]}" exec -T node-red node -e "fetch('http://127.0.0.1:1881/ready',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { printf 'API/private Node-RED readiness timed out\n' >&2; exit 1; }
printf 'Public API: %s\n' "$base"

response=''
request() {
  local operation="$1" method="$2" path="$3" expected="$4" body="${5:-}" code
  local arguments=(--silent --show-error --connect-timeout 5 --max-time 30 -X "$method"
    -H "Authorization: Bearer $API_TOKEN" -o "$evidence/response.json" -w '%{http_code}')
  if [[ -n "$body" ]]; then arguments+=(-H 'Content-Type: application/json' --data "$body"); fi
  printf '\n%s%s%s  %s /api/v1%s\n' "$blue" "$operation" "$reset" "$method" "$path"
  if [[ -n "$body" ]]; then printf '%s\n' "$body" | jq .; fi
  code="$(curl "${arguments[@]}" "$base$path")"
  response="$(cat "$evidence/response.json")"
  printf 'HTTP %s (expected %s)\n' "$code" "$expected"
  printf '%s\n' "$response" | jq .
  jq -cn --arg operation "$operation" --arg method "$method" --arg path "$path" --arg status "$code" --argjson body "$response" \
    '{operation:$operation,method:$method,path:$path,status:$status,body:$body}' >> "$evidence/http.jsonl"
  [[ "$code" == "$expected" ]] || { printf 'Unexpected HTTP status for %s\n' "$operation" >&2; exit 1; }
  printf '%s\n' "$operation" >> "$evidence/operations.txt"
}
wait_run() {
  local id="$1" expected="$2" deadline=$((SECONDS + run_timeout)) status
  printf '\nWaiting for Run %s → %s (bounded to %ss)\n' "$id" "$expected" "$run_timeout"
  while ((SECONDS < deadline)); do
    response="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 10 -H "Authorization: Bearer $API_TOKEN" "$base/runs/$id")"
    status="$(jq -er '.run.status' <<< "$response")"
    if [[ "$status" == "$expected" ]]; then request getRun GET "/runs/$id" 200; return; fi
    case "$status" in failed|rejected|cancelled|completed) printf '%s\n' "$response" | jq .; printf 'Unexpected terminal Run status: %s\n' "$status" >&2; exit 1;; esac
    sleep 1
  done
  printf 'Run %s did not reach %s\n' "$id" "$expected" >&2
  exit 1
}

section 'Discovery: public health, status and OpenAPI'
request getHealth GET /health 200
request getStatus GET /status 200
request getOpenApiDocument GET /openapi.json 200
printf '%s\n' "$response" > "$evidence/openapi.json"

section 'Projects: provision a working directory, inspect and rename'
request createProject POST /projects 201 '{"name":"API walkthrough"}'
owner="$(jq -er '.id' <<< "$response")"
request listProjects GET /projects 200
request getProject GET "/projects/$owner" 200
request updateProject PATCH "/projects/$owner" 200 '{"name":"API walkthrough renamed"}'

section 'Workflows: validate, create, retrieve and update a native multiplication flow'
definition='{"name":"Multiply","engine":"node-red","specification":{"entry":"entry","flows":[{"id":"tab","type":"tab","label":"Multiply"},{"id":"entry","z":"tab","type":"link in","x":100,"y":100,"wires":[["multiply"]]},{"id":"multiply","z":"tab","type":"function","x":250,"y":100,"outputs":1,"func":"msg.payload=msg.input.a*msg.input.b;return msg;","wires":[["native-return"]]},{"id":"native-return","z":"tab","type":"link out","x":400,"y":100,"mode":"return","links":[],"wires":[]}]}}'
request validateWorkflow POST /workflows/validate 200 "$(jq '{engine,specification}' <<< "$definition")"
jq -e '.valid == true' <<< "$response" >/dev/null
request createWorkflow POST /workflows 201 "$definition"
workflow="$(jq -er '.id' <<< "$response")"
request listWorkflows GET /workflows 200
request getWorkflow GET "/workflows/$workflow" 200
request updateWorkflow PUT "/workflows/$workflow" 200 "$(jq '.name="Multiply v2"' <<< "$definition")"

section 'Runs: execute 13.75 × -8, inspect status and ordered events'
request startRun POST /runs 202 "$(jq -cn --arg id "$workflow" --arg project "$owner" '{target:{kind:"workflow",id:$id},projectId:$project,input:{a:13.75,b:-8}}')"
native_run="$(jq -er '.run.id' <<< "$response")"
wait_run "$native_run" completed
jq -e '.run.output == -110 and .run.workflowVersion == 2' <<< "$response" >/dev/null
request listRuns GET "/runs?projectId=$owner" 200
request listEvents GET "/runs/$native_run/events?after=0" 200
section 'Documented limitations: run resume, SSE and artifacts (not fabricated successes)'
request resumeRun POST "/runs/$native_run/resume" 409 '{}'
jq -e '.error.code == "run_not_resumable"' <<< "$response" >/dev/null
request streamRunEvents GET "/runs/$native_run/events/stream" 501
request listArtifacts GET "/runs/$native_run/artifacts" 501
request getArtifact GET "/runs/$native_run/artifacts/demo-artifact" 501

section 'Human interaction: pause, discover an approval, decide and continue the same Run'
human="$(jq '.name="Approval" | .specification.flows[1].wires=[["human"]] | .specification.flows[2].func="msg.payload={decision:msg.interaction.decision,text:msg.interaction.text,input:msg.input};return msg;" | .specification.flows += [{id:"human",z:"tab",type:"interaction",x:175,y:100,name:"Approve",prompt:"Continue the demo?",promptType:"str",decisions:[{id:"approve",label:"Approve"}],wires:[["multiply"]]}]' <<< "$definition")"
request createWorkflow POST /workflows 201 "$human"
human_workflow="$(jq -er '.id' <<< "$response")"
human_start="$(jq -cn --arg id "$human_workflow" --arg project "$owner" '{target:{kind:"workflow",id:$id},projectId:$project,input:{proof:"original input survives"}}')"
request startRun POST /runs 202 "$human_start"
human_run="$(jq -er '.run.id' <<< "$response")"
wait_run "$human_run" paused
request listPendingInteractions GET "/interactions?projectId=$owner" 200
interaction="$(jq -er --arg run "$human_run" '.items[] | select(.runId==$run) | .id' <<< "$response")"
request submitInteractionDecision POST "/interactions/$interaction/decisions" 200 '{"decision":"approve","comment":"Continue from the checkpoint"}'
wait_run "$human_run" completed
jq -e '.run.output.decision == "approve" and .run.output.input.proof == "original input survives"' <<< "$response" >/dev/null
section 'Cancellation: cancel a second paused Run without dispatching an agent'
request startRun POST /runs 202 "$human_start"
cancelled_run="$(jq -er '.run.id' <<< "$response")"
wait_run "$cancelled_run" paused
request cancelRun POST "/runs/$cancelled_run/cancel" 200 '{"reason":"Demonstrate safe cancellation"}'
jq -e '.run.status == "cancelled"' <<< "$response" >/dev/null

section 'Conversations: metadata CRUD, real agent message and readable history'
request createConversation POST /conversations 201 "$(jq -cn --arg project "$owner" '{title:"API conversation",projectId:$project}')"
conversation="$(jq -er '.id' <<< "$response")"
request listConversations GET "/conversations?projectId=$owner" 200
request getConversation GET "/conversations/$conversation" 200
request updateConversation PATCH "/conversations/$conversation" 200 '{"title":"API conversation renamed"}'
request sendMessage POST "/conversations/$conversation/messages" 202 '{"content":"Reply with a short greeting. Do not use tools."}'
chat_run="$(jq -er '.run.id' <<< "$response")"
wait_run "$chat_run" completed
request listMessages GET "/conversations/$conversation/messages" 200
jq -e '([.items[] | select(.role=="user")] | length)==1 and ([.items[] | select(.role=="assistant")] | length)==1' <<< "$response" >/dev/null
request streamConversationEvents GET "/conversations/$conversation/events/stream" 501

section 'Delete demo resources in dependency order (project files are never erased by DELETE)'
request deleteConversation DELETE "/conversations/$conversation" 200
for id in "$native_run" "$human_run" "$cancelled_run" "$chat_run"; do request deleteRun DELETE "/runs/$id" 200; done
request deleteWorkflow DELETE "/workflows/$workflow" 200
request deleteWorkflow DELETE "/workflows/$human_workflow" 200
request deleteProject DELETE "/projects/$owner" 200

section 'Coverage: compare demonstrated technical operation names to served OpenAPI'
jq -r '.paths[][] | select(type=="object") | .operationId // empty' "$evidence/openapi.json" | sort -u > "$evidence/expected.txt"
sort -u "$evidence/operations.txt" > "$evidence/actual.txt"
diff -u "$evidence/expected.txt" "$evidence/actual.txt"
printf '%sPASS: %s/%s contract operations demonstrated%s\n' "$green" "$(wc -l < "$evidence/actual.txt")" "$(wc -l < "$evidence/expected.txt")" "$reset"
