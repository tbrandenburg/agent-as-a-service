.DEFAULT_GOAL := help
.PHONY: help install generate openapi catalog parity-doc check typecheck test validate-openapi parity format dev start start-opencode start-node-red demo-express demo-opencode demo-node-red demo-node-red-agents

help:
	@printf '%s\n' \
	  'install           Install workspace dependencies from the lockfile' \
	  'generate          Regenerate OpenAPI, catalog and Archon parity document' \
	  'check             Run typecheck, tests, OpenAPI/parity validation and format check' \
	  'format            Format TypeScript source' \
	  'dev               Start the example Express server in watch mode' \
	  'start             Start the example Express server' \
	  'start-opencode    Start the opencode-backed example server' \
	  'start-node-red    Start the Node-RED-backed API server locally' \
	  'demo-express      Run the simulated end-to-end workflow walkthrough' \
	  'demo-opencode     Build Docker and run the real published-port walkthrough' \
	  'demo-node-red     Build Docker and run the real Node-RED walkthrough' \
	  'demo-node-red-agents  Run the real writer/reviewer Node-RED walkthrough'

install:
	npm ci

generate:
	npm run openapi
	npm run catalog
	npm run parity:doc

openapi:
	npm run openapi

catalog:
	npm run catalog

parity-doc:
	npm run parity:doc

check: typecheck test validate-openapi parity
	npm run format:check

typecheck:
	npm run typecheck

test:
	npm test

validate-openapi:
	npm run validate:openapi

parity:
	npm run check:parity

format:
	npm run format

dev:
	npm run dev

start:
	npm start

start-opencode:
	npm run start:opencode

start-node-red:
	npm run start:node-red

demo-express:
	npm run demo:express

demo-opencode:
	@set -eu; \
	project="aas-opencode-demo-$$$$"; \
	export API_TOKEN="$${API_TOKEN:-dev-token}"; \
	cleanup() { docker compose -p "$$project" -f examples/server-opencode/compose.yaml down --volumes --remove-orphans; }; \
	trap cleanup EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	docker compose -p "$$project" -f examples/server-opencode/compose.yaml up --build -d; \
	ready=0; \
	for attempt in $$(seq 1 60); do \
	  if curl --fail --silent http://127.0.0.1:3092/health >/dev/null; then ready=1; break; fi; \
	  sleep 1; \
	done; \
	if [ "$$ready" -ne 1 ]; then docker compose -p "$$project" -f examples/server-opencode/compose.yaml logs; exit 1; fi; \
	DEMO_BASE_URL=http://127.0.0.1:3092 npm run demo:opencode

demo-node-red:
	@set -eu; \
	listeners="$$(ss -H -ltn '( sport = :3093 )')"; \
	if [ -n "$$listeners" ]; then printf '%s\n' 'Port 3093 is occupied; refusing to start Compose'; exit 1; fi; \
	project="aas-node-red-demo-$$$$"; \
	export API_TOKEN="$${API_TOKEN:-dev-token}"; \
	cleanup() { docker compose -p "$$project" -f examples/server-node-red/compose.yaml down --volumes --remove-orphans; }; \
	trap cleanup EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	docker compose -p "$$project" -f examples/server-node-red/compose.yaml up --build -d; \
	ready=0; \
	for attempt in $$(seq 1 90); do \
	  if curl --fail --silent http://127.0.0.1:3093/api/v1/health >/dev/null; then ready=1; break; fi; \
	  sleep 1; \
	done; \
	if [ "$$ready" -ne 1 ]; then docker compose -p "$$project" -f examples/server-node-red/compose.yaml logs; exit 1; fi; \
	DEMO_BASE_URL=http://127.0.0.1:3093 npm run demo:node-red

demo-node-red-agents:
	@set -eu; \
	listeners="$$(ss -H -ltn '( sport = :3094 )')"; \
	if [ -n "$$listeners" ]; then printf '%s\n' 'Port 3094 is occupied; refusing to start Compose'; exit 1; fi; \
	project="aas-node-red-agents-demo-$$$$"; \
	export API_TOKEN="$${API_TOKEN:-dev-token}"; \
	export INTERNAL_TOKEN="$${INTERNAL_TOKEN:-internal-checkpoint-demo-token}"; \
	if [ "$$API_TOKEN" = "$$INTERNAL_TOKEN" ]; then printf '%s\n' 'Internal and public tokens must differ'; exit 1; fi; \
	cleanup() { docker compose -p "$$project" -f examples/server-node-red-agents/compose.yaml down --volumes --remove-orphans; }; \
	trap cleanup EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	docker compose -p "$$project" -f examples/server-node-red-agents/compose.yaml up --build -d; \
	ready=0; \
	for attempt in $$(seq 1 90); do \
	  if curl --fail --silent http://127.0.0.1:3094/api/v1/health >/dev/null && docker compose -p "$$project" -f examples/server-node-red-agents/compose.yaml exec -T node-red node -e "fetch('http://127.0.0.1:1880/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi; \
	  sleep 1; \
	done; \
	if [ "$$ready" -ne 1 ]; then docker compose -p "$$project" -f examples/server-node-red-agents/compose.yaml logs; exit 1; fi; \
	DEMO_BASE_URL=http://127.0.0.1:3094 npm run demo:node-red-agents
