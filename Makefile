.DEFAULT_GOAL := help
.PHONY: help install generate openapi catalog parity-doc check typecheck test validate-openapi parity format dev start start-opencode demo-express demo-opencode

help:
	@printf '%s\n' \
	  'install           Install workspace dependencies from the lockfile' \
	  'generate          Regenerate OpenAPI, catalog and Archon parity document' \
	  'check             Run typecheck, tests, OpenAPI/parity validation and format check' \
	  'format            Format TypeScript source' \
	  'dev               Start the example Express server in watch mode' \
	  'start             Start the example Express server' \
	  'start-opencode    Start the opencode-backed example server' \
	  'demo-express      Run the simulated end-to-end workflow walkthrough' \
	  'demo-opencode     Build Docker and run the real published-port walkthrough'

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
