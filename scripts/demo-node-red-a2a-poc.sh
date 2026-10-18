#!/usr/bin/env bash
# EXPERIMENTAL sibling to scripts/demo-node-red-apis.sh.
# Uses the same disposable Node-RED Compose backend, reached only via A2A-shaped
# structured SendMessage requests through scripts/poc-a2a/bridge.mjs.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
for dependency in docker curl openssl timeout ss node; do
  command -v "$dependency" >/dev/null || { printf 'Missing dependency: %s\n' "$dependency" >&2; exit 1; }
done
docker compose version >/dev/null
export DEFAULT_MODEL="${DEFAULT_MODEL-github-copilot/gpt-6-luna}"
API_TOKEN="$(openssl rand -hex 24)"
INTERNAL_TOKEN="$(openssl rand -hex 24)"
export API_TOKEN INTERNAL_TOKEN
project="aas-a2a-poc-$(openssl rand -hex 8)"
mkdir -p /tmp/opencode
evidence="$(mktemp -d /tmp/opencode/aas-a2a-poc-XXXXXXXX)"
compose=(docker compose -p "$project" -f "$root/examples/server-node-red-agents/compose.yaml")
bridge_pid=''
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$bridge_pid" ]]; then
    kill "$bridge_pid" 2>/dev/null || true
    wait "$bridge_pid" 2>/dev/null || true
  fi
  if ! timeout 120 "${compose[@]}" down --volumes --remove-orphans --rmi local > "$evidence/cleanup.log" 2>&1; then
    cat "$evidence/cleanup.log" >&2
    status=1
  fi
  printf 'PoC status: %s | Evidence: %s\n' "$status" "$evidence"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Same preflight intent as original walkthrough; no pre-existing Docker projects touched.
docker_root="$(docker info --format '{{.DockerRootDir}}')"
available="$(df -Pk "$docker_root" | awk 'NR == 2 {print $4}')"
if [[ ! "$available" =~ ^[0-9]+$ ]] || ((available < 4 * 1024 * 1024)); then
  echo 'Docker storage needs at least 4 GiB free' >&2
  exit 1
fi
mkdir -p "$root/.home"
printf 'Building isolated Node-RED backend (logs: %s/build.log)\n' "$evidence"
timeout 600 "${compose[@]}" up --build -d > "$evidence/build.log" 2>&1 || {
  tail -60 "$evidence/build.log" >&2; exit 1;
}
binding="$(timeout 10 "${compose[@]}" port api 3094)"
[[ "$binding" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { echo "Unexpected binding: $binding" >&2; exit 1; }
base="http://$binding/api/v1"
ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if curl --max-time 2 --fail --silent "$base/health" >/dev/null &&
    timeout 5 "${compose[@]}" exec -T node-red node -e "fetch('http://127.0.0.1:1881/ready',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'Backend readiness timed out' >&2; exit 1; }
# Choose an ephemeral loopback port for the A2A PoC facade.
bridge_port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
AAAS_UPSTREAM_URL="$base" A2A_PORT="$bridge_port" A2A_HOST=127.0.0.1 \
  node "$root/scripts/poc-a2a/bridge.mjs" > "$evidence/bridge.log" 2>&1 &
bridge_pid=$!
a2a="http://127.0.0.1:$bridge_port"
ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if curl --max-time 2 --fail --silent "$a2a/.well-known/agent-card.json" >/dev/null; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { cat "$evidence/bridge.log" >&2; echo 'A2A dispatcher not ready' >&2; exit 1; }
printf 'Running A2A-shaped command coverage against %s\n' "$a2a"
A2A_URL="$a2a" A2A_AUTH_TOKEN="$API_TOKEN" \
  A2A_DEMO_AGENT="${A2A_DEMO_AGENT:-0}" RUN_TIMEOUT="${RUN_TIMEOUT:-180}" \
  node "$root/scripts/poc-a2a/demo.mjs" 2>&1 | tee "$evidence/demo.log"
printf 'PoC evidence: %s\n' "$evidence"
