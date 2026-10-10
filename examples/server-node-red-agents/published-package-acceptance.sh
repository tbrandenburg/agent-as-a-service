#!/usr/bin/env bash
set -euo pipefail

project="aas-published-${RANDOM}-${RANDOM}-$$"
image="aas-published-node-red-host:${RANDOM}-${RANDOM}-$$"
evidence="${EVIDENCE_DIR:-/tmp/opencode/$project}"
if [[ -z "${EVIDENCE_DIR:-}" ]]; then
  mkdir -p /tmp/opencode
fi
if ! mkdir -- "$evidence"; then
  echo "Evidence directory must not already exist: $evidence" >&2
  exit 1
fi
version="$(npm view @tbrandenburg/node-red-host@0.1.1 version)"
test "$version" = "0.1.1"
export COMPOSE_PROJECT_NAME="$project"
export DEMO_COMPOSE_PROJECT="$project"
export CONSUMER_IMAGE="$image"
export API_TOKEN="$(openssl rand -hex 32)"
export INTERNAL_TOKEN="$(openssl rand -hex 32)"
test "$API_TOKEN" != "$INTERNAL_TOKEN"
export MAX_WORKERS=1
export NODE_RED_COMPOSE_FILES="examples/server-node-red-agents/compose.yaml,examples/server-node-red-agents/node-red/fixtures/compose.native.yaml,examples/server-node-red-agents/node-red/compose.consumer.yaml"
compose=(docker compose -p "$project" -f examples/server-node-red-agents/compose.yaml -f examples/server-node-red-agents/node-red/fixtures/compose.native.yaml -f examples/server-node-red-agents/node-red/compose.consumer.yaml)

cleanup() {
  status=$?
  trap - EXIT
  "${compose[@]}" logs --no-color > "$evidence/containers.log" 2>&1 || status=1
  "${compose[@]}" down --volumes --remove-orphans > "$evidence/cleanup.log" 2>&1 || status=1
  if [ "$status" -eq 0 ]; then
    printf 'Compose project %s removed with its volumes and network.\n' "$project" >> "$evidence/cleanup.log"
  fi
  docker image rm "$image" >> "$evidence/cleanup.log" 2>&1 || status=1
  node - "$evidence" "$API_TOKEN" "$INTERNAL_TOKEN" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [directory, ...secrets] = process.argv.slice(2);
const files = [
  "listeners-before.log",
  "storage.log",
  "compose-config.json",
  "build.log",
  "start.log",
  "package-version.log",
  "registry.log",
  "interaction-http.log",
  "native-http.log",
  "final-capacity.log",
  "attempts.log",
  "lifecycle.log",
  "containers.log",
  "cleanup.log",
];
for (const file of files) {
  const target = path.join(directory, file);
  if (!fs.existsSync(target)) continue;
  if (!fs.lstatSync(target).isFile()) continue;
  let value = fs.readFileSync(target, "utf8");
  for (const secret of secrets) {
    value = value.replaceAll(secret, "<redacted>");
  }
  fs.writeFileSync(target, value);
}
NODE
  if [ "$status" -eq 0 ]; then
    printf 'Published package consumer acceptance passed for %s on Node-RED 5.0.7.\n' "$version" > "$evidence/result.log"
  else
    printf 'Published package consumer acceptance failed with status %s.\n' "$status" > "$evidence/result.log"
  fi
  printf 'Acceptance exit status: %s\nEvidence: %s\n' "$status" "$evidence"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ss -H -ltn > "$evidence/listeners-before.log"
df -h /tmp > "$evidence/storage.log"
docker system df >> "$evidence/storage.log"
"${compose[@]}" config --format json | node -e '
let config="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>config+=chunk);process.stdin.on("end",()=>{const value=JSON.parse(config);const service=value.services["node-red"];if(service.image!==process.env.CONSUMER_IMAGE)throw Error("consumer image mismatch");if(service.ports?.length)throw Error("consumer host ports must remain private");if(service.build?.dockerfile!=="Dockerfile.consumer"||!service.build.context.endsWith("/examples/server-node-red-agents/node-red"))throw Error("consumer build context mismatch");if(service.volumes.some(volume=>/node-red-host|packages\//i.test(volume.source??"")))throw Error("local host source mount detected");for(const service of Object.values(value.services))for(const [key,item]of Object.entries(service.environment??{}))if(["API_TOKEN","INTERNAL_TOKEN"].includes(key))service.environment[key]="<redacted>";process.stdout.write(JSON.stringify(value,null,2)+"\n")})' > "$evidence/compose-config.json"
if grep -E 'COPY .*packages/node-red-host|npm pack|node-red-host.*(\.\./|packages/)' examples/server-node-red-agents/node-red/Dockerfile.consumer; then
  printf '%s\n' 'Consumer Dockerfile contains a local host package source reference' >&2
  exit 1
fi

"${compose[@]}" build --no-cache > "$evidence/build.log" 2>&1
"${compose[@]}" up -d > "$evidence/start.log" 2>&1
address=""
for attempt in $(seq 1 30); do
  address="$("${compose[@]}" port api 3094 2>> "$evidence/start.log")" || true
  if [ -n "$address" ]; then break; fi
  sleep 1
done
test -n "$address"
export DEMO_BASE_URL="http://127.0.0.1:${address##*:}"
ready=0
for attempt in $(seq 1 90); do
  if curl --fail --silent "$DEMO_BASE_URL/api/v1/health" >/dev/null && "${compose[@]}" exec -T node-red node -e "fetch('http://127.0.0.1:1881/ready',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" -eq 1
"${compose[@]}" exec -T node-red npm ls --global @tbrandenburg/node-red-host > "$evidence/package-version.log"
"${compose[@]}" exec -T node-red npm ls --prefix /data @tbrandenburg/node-red-agents >> "$evidence/package-version.log"
user_id="$("${compose[@]}" exec -T node-red id -u)"
test "$user_id" = "1000"
"${compose[@]}" exec -T node-red id -un >> "$evidence/package-version.log"
"${compose[@]}" exec -T node-red node -e "const v=require('/usr/src/node-red/node_modules/node-red/package.json').version;if(v!=='5.0.7')process.exit(1);console.log('stock Node-RED '+v)" >> "$evidence/package-version.log"
printf 'npm registry @tbrandenburg/node-red-host@%s\n' "$version" > "$evidence/registry.log"

node --import tsx examples/server-node-red-agents/src/interaction-e2e.ts | tee "$evidence/interaction-http.log"
node --import tsx examples/server-node-red-agents/src/published-package-native.ts | tee "$evidence/native-http.log"
capacity=""
for attempt in $(seq 1 100); do
  capacity="$("${compose[@]}" exec -T node-red node -e "fetch('http://127.0.0.1:1881/capacity',{headers:{authorization:'Bearer '+process.env.INTERNAL_TOKEN}}).then(async r=>{const c=await r.json();if(!r.ok||c.occupied!==0||c.waiting.length!==0)process.exit(1);process.stdout.write(JSON.stringify(c))}).catch(()=>process.exit(1))" 2>/dev/null)" || true
  if [ -n "$capacity" ]; then break; fi
  sleep 0.2
done
test -n "$capacity"
printf '%s\n' "$capacity" > "$evidence/final-capacity.log"
"${compose[@]}" logs --no-color node-red > "$evidence/attempts.log"
EVIDENCE="$evidence/attempts.log" node -e '
const fs=require("node:fs");const records=fs.readFileSync(process.env.EVIDENCE,"utf8").split("\n").flatMap(line=>{const start=line.indexOf("{\"type\":\"attempt.");if(start<0)return [];try{return [JSON.parse(line.slice(start))]}catch{return []}});const starts=records.filter(item=>item.type==="attempt.started");const stops=records.filter(item=>item.type==="attempt.stopped");if(!starts.length||starts.length!==stops.length||starts.some(start=>!stops.some(stop=>stop.attemptId===start.attemptId)))process.exit(1);console.log(JSON.stringify({started:starts.length,stopped:stops.length,allAttemptsStopped:true}))' | tee "$evidence/lifecycle.log"
