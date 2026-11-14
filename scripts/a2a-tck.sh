#!/usr/bin/env bash
set -euo pipefail
url="${1:?Usage: scripts/a2a-tck.sh A2A_URL}"
revision="104a7b4ae0d83f65c075e3793e322953a830eaba"
command -v uv >/dev/null || { printf 'Missing uv\n' >&2; exit 2; }
command -v ss >/dev/null || { printf 'Missing ss\n' >&2; exit 2; }
for dependency in git timeout curl; do
  command -v "$dependency" >/dev/null || { printf 'Missing %s\n' "$dependency" >&2; exit 2; }
done
: "${A2A_TOKEN:?A2A_TOKEN is required for the TCK auth bridge}"
if ss -H -ltn | awk '{print $4}' | grep -Eq '(^|:)3096$'; then
  printf 'Port 3096 is occupied; refusing to interrupt an existing service\n' >&2
  exit 2
fi
evidence="$(mktemp -d /tmp/opencode/a2a-tck-XXXXXXXX)"
checkout="$evidence/tck"
proxy_pid=''
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$proxy_pid" ]] && kill -0 "$proxy_pid" 2>/dev/null; then
    kill "$proxy_pid" 2>/dev/null || status=1
    wait "$proxy_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git clone --quiet https://github.com/a2aproject/a2a-tck.git "$checkout"
git -C "$checkout" checkout --quiet "$revision"
printf 'revision=%s\npython_requirement=>=3.15\nuv=%s\npython=%s\nsut=%s\n' \
  "$revision" "$(uv --version)" \
  "$(UV_CACHE_DIR="$evidence/uv-cache" uv run --python 3.15 --no-project python --version)" "$url" > "$evidence/metadata.txt"
UV_CACHE_DIR="$evidence/uv-cache" uv lock --project "$checkout" --upgrade-package grpcio > "$evidence/dependency-lock.log" 2>&1
cp "$checkout/uv.lock" "$evidence/tck-uv.lock"
printf 'grpcio=%s\nuv_lock_sha256=%s\n' \
  "$(awk '/^\[\[package\]\]$/ { found=0 } /^name = "grpcio"$/ { found=1 } found && /^version =/ { gsub(/"/, ""); print $3; exit }' "$checkout/uv.lock")" \
  "$(sha256sum "$checkout/uv.lock" | awk '{print $1}')" >> "$evidence/metadata.txt"
A2A_TARGET_URL="$url" A2A_TOKEN="${A2A_TOKEN:?A2A_TOKEN is required for the TCK auth bridge}" \
  node scripts/a2a-tck-auth-proxy.mjs > "$evidence/auth-proxy.log" 2>&1 &
proxy_pid=$!
ready=0
for ((attempt=0; attempt<20; attempt++)); do
  if curl --connect-timeout 1 --max-time 2 --fail --silent http://127.0.0.1:3096/.well-known/agent-card.json >/dev/null; then ready=1; break; fi
  sleep 0.2
done
[[ "$ready" -eq 1 ]] || { printf 'TCK auth proxy did not start\n' >&2; exit 1; }
set +e
(cd "$checkout" && UV_CACHE_DIR="$evidence/uv-cache" timeout 600 uv run --python 3.15 --project . ./run_tck.py \
  --sut-host http://127.0.0.1:3096 --transport http_json --level must) > "$evidence/tck.log" 2>&1
result=$?
set -e
printf 'exit_status=%s\n' "$result" >> "$evidence/metadata.txt"
if [[ -f "$checkout/reports/compatibility.json" ]]; then
  cp "$checkout/reports/compatibility.json" "$evidence/compatibility.json"
fi
cat "$evidence/tck.log"
printf 'TCK_EVIDENCE=%s\n' "$evidence"
exit "$result"
