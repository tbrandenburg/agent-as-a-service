#!/usr/bin/env bash
set -euo pipefail
project="aaas-native-acceptance-${RANDOM}-${RANDOM}"
export DEFAULT_MODEL=github-copilot/gpt-6-luna
export API_TOKEN=dev-token
export NATIVE_BOUNDED_TIMEOUT=true
compose() { docker compose -p "$project" -f examples/server-node-red-agents/compose.yaml -f examples/server-node-red-agents/node-red/fixtures/compose.native.yaml "$@"; }
cleanup() {
  status=$?
  trap - EXIT
  compose down --volumes --remove-orphans || exit 1
  docker image rm "${project}-api:latest" "${project}-node-red:latest" || exit 1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
df -h .
ss -H -ltn
compose up --build -d
binding="$(compose port api 3094)"
export DEMO_BASE_URL="http://${binding}" DEMO_COMPOSE_PROJECT="$project"
for ((attempt=0;attempt<90;attempt++)); do
  if curl --fail --silent --max-time 2 "$DEMO_BASE_URL/api/v1/health" >/dev/null; then break; fi
  sleep 1
done
node --import tsx examples/server-node-red-agents/src/native-demo.ts || { compose logs; exit 1; }
