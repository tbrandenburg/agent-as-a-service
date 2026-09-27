.DEFAULT_GOAL := help
.PHONY: help install generate openapi catalog parity-doc check typecheck test validate-openapi parity format dev start demo

help:
	@printf '%s\n' \
	  'install           Install workspace dependencies from the lockfile' \
	  'generate          Regenerate OpenAPI, catalog and Archon parity document' \
	  'check             Run typecheck, tests, OpenAPI/parity validation and format check' \
	  'format            Format TypeScript source' \
	  'dev               Start the example Express server in watch mode' \
	  'start             Start the example Express server' \
	  'demo              Run an end-to-end simulated workflow walkthrough'

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

demo:
	npm run demo
