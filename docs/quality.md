# Contract-first validation

The contract is the production deliverable. Servers and clients under `examples/`
demonstrate how independent implementations can consume it; they are not a hosted
service or a promise of production persistence, availability, or provider behavior.

## Priorities

- Preserve schema compatibility: required/optional/null fields, input/output unions,
  typed errors, resource links, pagination and event semantics.
- Keep `openapi.json`, the endpoint catalog and parity document synchronized with
  their sources. `make check-generated` regenerates them and fails on Git diffs.
- Keep engine/provider-specific assumptions out of `packages/contract/`.
- Validate portable examples against both Zod and the generated OpenAPI schema.
  The [published examples](/docs/api-examples.json) cover run requests/results,
  typed errors, projects, messages and opaque workflow definitions.

OpenAPI cannot express every Zod refinement. For example, a run's primary
conversation must occur in its conversation-link list. Conformance tests explicitly
identify this Zod-only invariant rather than pretending JSON Schema enforces it.
The OpenAPI 3 `nullable` annotation is translated to a JSON Schema null alternative
for test validation; published OpenAPI is not rewritten by the tests.

## Checks

| Command | Purpose |
| --- | --- |
| `make check-contract` | Contract tests, OpenAPI validation, parity and generated-artifact drift |
| `make check` | Workspace lint, typing, regression tests, formatting and contract artifact checks |
| `make security` | Audit committed root and nested runtime dependency lockfiles |
| `make test-native-node-red-agents` | Real Node-RED 5.0.7 boundary/failure/cleanup tests in an isolated container |
| `make demo-express` | Fast simulated HTTP/client conformance walkthrough |

Routine CI labels contract validation separately and retains inexpensive example
regression tests. The native Node-RED job is path-filtered to that example, shared
contract/dependency changes and its workflow configuration; it can also be run
manually. It publishes no host ports and removes its test image afterward.

Provider-backed Docker walkthroughs remain manual acceptance for changes to the
relevant adapter or its setup instructions. Inspect occupied ports before starting
services, use dynamic ports where supported, and remove only test-owned resources.
For model-backed Node-RED testing, use `DEFAULT_MODEL=github-copilot/gpt-6-luna`.

## Example scope

Add example behavior only to demonstrate a contract capability or resolve a
concrete implementation ambiguity. Fix correctness and setup defects, keep useful
boundary regressions, and document unsupported capabilities honestly. Avoid
production-platform features, broad backend refactors and coverage/complexity
targets that do not improve contract confidence. Mutation testing and the custom
example quality-ratchet framework are not part of the current validation setup.
