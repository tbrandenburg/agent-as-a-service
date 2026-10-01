#!/usr/bin/env bash
set -euo pipefail
image="aaas-native-test-${RANDOM}-${RANDOM}"
cleanup() {
  status=$?
  trap - EXIT
  docker image rm "$image" >/dev/null || exit 1
  exit "$status"
}
docker build -f examples/server-node-red-agents/node-red/Dockerfile.native-test -t "$image" .
trap cleanup EXIT
# Tests bind only container-local ephemeral ports; nothing is published to the host.
docker run --rm --network none "$image"
