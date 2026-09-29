#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$root/examples/server-node-red-agents/compose.yaml"
action="${1:-}"

compose() { docker compose -p "$project" -f "$compose_file" "$@"; }

url() {
  local binding port
  binding="$(compose port api 3094)"
  if [[ ! "$binding" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
    printf 'Unexpected API port binding: %s\n' "$binding" >&2
    return 1
  fi
  port="${BASH_REMATCH[1]}"
  printf 'http://127.0.0.1:%s' "$port"
}

ready() {
  local base="$1" attempt
  for ((attempt = 1; attempt <= 90; attempt++)); do
    if curl --max-time 2 --fail --silent "$base/api/v1/health" >/dev/null &&
      compose exec -T node-red node -e "Promise.all([fetch('http://127.0.0.1:1880/ready'),fetch('http://api:3095/observations',{method:'POST'})]).then(([flow,callback]) => process.exit(flow.ok && callback.status === 401 ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'API or private Node-RED entry did not become ready for %s\n' "$project" >&2
  compose logs >&2
  return 1
}

credentials() {
  if [[ "$API_TOKEN" == "$INTERNAL_TOKEN" || "$API_TOKEN" == "$NODE_RED_ADMIN_TOKEN" || "$INTERNAL_TOKEN" == "$NODE_RED_ADMIN_TOKEN" ]]; then
    printf 'API_TOKEN, INTERNAL_TOKEN and NODE_RED_ADMIN_TOKEN must differ\n' >&2
    exit 1
  fi
}

if [[ "$action" == demo ]]; then
  project="aas-node-red-agents-demo-$(< /proc/sys/kernel/random/uuid)"
  export API_TOKEN="${API_TOKEN:-dev-token}" INTERNAL_TOKEN="${INTERNAL_TOKEN:-internal-observer-demo-token}" NODE_RED_ADMIN_TOKEN="${NODE_RED_ADMIN_TOKEN:-internal-admin-demo-token}"
  credentials
  cleanup_demo() {
    local status=$? image
    trap - EXIT
    compose down --volumes --remove-orphans || status=1
    for image in "${project}-api:latest" "${project}-node-red:latest"; do
      if docker image inspect "$image" >/dev/null 2>&1; then
        docker image rm "$image" >/dev/null || status=1
      fi
    done
    exit "$status"
  }
  trap cleanup_demo EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  compose up --build -d || { compose logs >&2; exit 1; }
  base="$(url)" || { compose logs >&2; exit 1; }
  ready "$base"
  printf 'Disposable project: %s | URL: %s\n' "$project" "$base"
  (cd "$root" && DEMO_BASE_URL="$base" npm run demo:node-red-agents) || { compose logs >&2; exit 1; }
  exit
fi

if [[ ! "$action" =~ ^(start|status|logs|stop|cleanup)$ ]]; then
  printf 'Usage: %s {start|status|logs|stop|cleanup|demo} (named actions require INSTANCE)\n' "$0" >&2
  exit 2
fi

instance="${INSTANCE:-}"
if [[ ! "$instance" =~ ^[a-z][a-z0-9-]{0,39}$ || "$instance" == demo-* ]]; then
  printf 'INSTANCE must be 1-40 lowercase letters, digits or hyphens, starting with a letter (demo-* is reserved)\n' >&2
  exit 2
fi
project="aas-node-red-agents-$instance"

case "$action" in
  start)
    : "${API_TOKEN:?Set API_TOKEN for this named instance}"
    : "${INTERNAL_TOKEN:?Set INTERNAL_TOKEN for this named instance}"
    : "${NODE_RED_ADMIN_TOKEN:?Set NODE_RED_ADMIN_TOKEN for this named instance}"
    credentials
    if [[ -n "$(compose ps --all --quiet)" ]]; then
      printf 'Instance %s already exists. Use status or stop first.\n' "$instance" >&2
      bash "$0" status
      exit 1
    fi
    compose up --build -d || { compose logs >&2; exit 1; }
    base="$(url)" || { compose logs >&2; exit 1; }
    ready "$base"
    printf 'Instance: %s | Project: %s | URL: %s\n' "$instance" "$project" "$base"
    printf 'Inspect: make status-node-red-agents INSTANCE=%s | make logs-node-red-agents INSTANCE=%s\n' "$instance" "$instance"
    printf 'Stop: make stop-node-red-agents INSTANCE=%s\n' "$instance"
    ;;
  status)
    if [[ -z "$(compose ps --quiet api)" ]]; then
      printf 'Instance %s is not running (project %s)\n' "$instance" "$project"
      exit 1
    fi
    printf 'Instance: %s | Project: %s | URL: %s\n' "$instance" "$project" "$(url)"
    compose ps
    ;;
  logs) compose logs --no-color --tail=100 ;;
  stop) compose down --remove-orphans ;;
  cleanup) compose down --volumes --remove-orphans ;;
esac
