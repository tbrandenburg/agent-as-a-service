.DEFAULT_GOAL := help

NODE_RED_HOST_PACKAGE_DIR := packages/node-red-host
NODE_RED_HOST_PACKAGE_JSON := $(NODE_RED_HOST_PACKAGE_DIR)/package.json
BUMP ?=
.PHONY: help install generate openapi catalog parity-doc check check-contract check-generated security release lint format-check typecheck test test-contract test-native-node-red-agents validate-openapi parity format dev start start-opencode start-node-red demo-express demo-opencode demo-node-red demo-node-red-agents smoke-node-red-agents spawn-node-red-agents start-node-red-agents status-node-red-agents logs-node-red-agents stop-node-red-agents cleanup-node-red-agents

help:
	@printf '%s\n' \
	  'install           Install workspace dependencies from the lockfile' \
	  'generate          Regenerate OpenAPI, catalog and Archon parity document' \
	  'check             Run lint, typecheck, tests, OpenAPI/parity and format checks' \
	  'security          Audit root and Node-RED agent npm dependencies' \
	  'release           Validate, bump and tag node-red-host (BUMP=patch|minor|major)' \
	  'lint              Lint TypeScript source with Oxlint' \
	  'check-contract    Check contract tests, OpenAPI/parity and generated artifacts' \
	  'check-generated   Regenerate published artifacts and fail on drift' \
	  'test-contract     Run engine-neutral contract conformance tests' \
	  'test-native-node-red-agents  Run isolated real Node-RED runtime tests' \
	  'format-check      Check TypeScript formatting with Prettier' \
	  'format            Format TypeScript source' \
	  'dev               Start the example Express server in watch mode' \
	  'start             Start the example Express server' \
	  'start-opencode    Start the opencode-backed example server' \
	  'start-node-red    Start the Node-RED-backed API server locally' \
	  'demo-express      Run the simulated end-to-end workflow walkthrough' \
	  'demo-opencode     Build Docker and run the real published-port walkthrough' \
	  'demo-node-red     Build Docker and run the real Node-RED walkthrough' \
	  'demo-node-red-agents  Run a disposable lifecycle-observed Node-RED walkthrough' \
	  'smoke-node-red-agents  Run one provider-free multiplication roundtrip with timings' \
	  'spawn-node-red-agents    Start a persistent instance with a generated name (two distinct tokens required)' \
	  'start-node-red-agents    Start named instance (INSTANCE and two distinct tokens required)' \
	  'status-node-red-agents   Show named instance URL and containers (INSTANCE required)' \
	  'logs-node-red-agents     Show named instance logs (INSTANCE required)' \
	  'stop-node-red-agents     Stop named instance, retain volumes (INSTANCE required)' \
	  'cleanup-node-red-agents  Remove named instance and its volumes (INSTANCE required)'

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

check: lint typecheck test validate-openapi parity format-check check-generated

check-contract: test-contract validate-openapi parity check-generated

check-generated: generate
	git diff --exit-code HEAD -- openapi.json docs/catalog.md docs/rest-parity.md
	npm run build:validator --workspace=@tbrandenburg/node-red-host
	git diff --exit-code -- packages/node-red-host/lib/run-output.cjs

security:
	npm audit
	npm audit --prefix examples/server-node-red-agents/node-red

release:
	@case "$(BUMP)" in \
		patch|minor|major) ;; \
		*) echo "usage: make release BUMP=patch|minor|major"; exit 1;; \
	esac
	@status="$$(git status --porcelain --untracked-files=all)" && [ -z "$$status" ] || \
		(echo "release: working tree has uncommitted or untracked changes -- commit or stash first" && exit 1)
	$(MAKE) install
	$(MAKE) security
	$(MAKE) check
	cd $(NODE_RED_HOST_PACKAGE_DIR) && npm pack --dry-run
	cd $(NODE_RED_HOST_PACKAGE_DIR) && npm version $(BUMP) --no-git-tag-version
	npm install --package-lock-only --workspaces >/dev/null
	git add $(NODE_RED_HOST_PACKAGE_JSON) package-lock.json
	git commit -m "release: node-red-host v`node -p \"require('./$(NODE_RED_HOST_PACKAGE_JSON)').version\"`"
	git tag -a "node-red-host@`node -p \"require('./$(NODE_RED_HOST_PACKAGE_JSON)').version\"`" -m "release: node-red-host v`node -p \"require('./$(NODE_RED_HOST_PACKAGE_JSON)').version\"`"
	@echo "Tagged node-red-host@`node -p \"require('./$(NODE_RED_HOST_PACKAGE_JSON)').version\"` on `git rev-parse --short HEAD`."
	@echo "Next: git push --follow-tags. The tag triggers the OIDC npm publish workflow."

lint:
	npm run lint

format-check:
	npm run format:check

typecheck:
	npm run typecheck

test:
	npm test

test-contract:
	npm run test:contract

test-native-node-red-agents:
	@bash examples/server-node-red-agents/native-test.sh

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
	  if curl --fail --silent http://127.0.0.1:3093/api/v1/health >/dev/null && docker compose -p "$$project" -f examples/server-node-red/compose.yaml exec -T node-red node -e "fetch('http://127.0.0.1:1880/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi; \
	  sleep 1; \
	done; \
	if [ "$$ready" -ne 1 ]; then docker compose -p "$$project" -f examples/server-node-red/compose.yaml logs; exit 1; fi; \
	DEMO_BASE_URL=http://127.0.0.1:3093 npm run demo:node-red

demo-node-red-agents:
	@bash examples/server-node-red-agents/instance.sh demo

smoke-node-red-agents:
	@node --import tsx examples/server-node-red-agents/src/smoke.ts

spawn-node-red-agents start-node-red-agents status-node-red-agents logs-node-red-agents stop-node-red-agents cleanup-node-red-agents:
	@bash examples/server-node-red-agents/instance.sh $(patsubst %-node-red-agents,%,$@)
