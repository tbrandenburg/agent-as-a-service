# Warning-first quality drift measurements

Issue #37 adds measurements for the Node-RED agent example without requiring a
brownfield backend split. Existing lint, type, test and formatting failures remain
blocking. Metric growth and score regressions emit GitHub `::warning::` annotations
and exit successfully; missing, malformed or incomplete measurements fail.

## Commands and placement

| Command | Measurement | Placement |
| --- | --- | --- |
| `make quality` | Source/test physical lines, paired test:source ratios, classic cyclomatic complexity | Local; `make lint` and PR lint CI |
| `make test` | Existing workspace Vitest suite plus wall-clock and per-file runtime | Local `make check`; PR test CI |
| `make quality-test` | Quality reporter integrity and failure-path tests | `make check`; PR CI |
| `make quality-coverage` | V8 branch coverage, aggregate and per-file | Dedicated PR CI job |
| `make quality-mutation` | Stryker mutations of the complete `managed.ts` module | Weekly Monday 03:00 UTC; manual dispatch |
| `npm run quality:baseline` | Tighten reviewed baseline after fresh measurements | Explicit maintenance only |

Outputs are under ignored `data/quality/`; CI uploads coverage and mutation reports
even on failures and writes regression summaries to the Actions job summary.
The weekly job has a twenty-minute job timeout and a fifteen-minute command bound.
Tests use `DEFAULT_MODEL=github-copilot/gpt-6-luna` in quality CI; these commands
do not invoke providers or Docker.

## Scope and baseline

[`settings.ts`](/scripts/quality/settings.ts) selects adapter production TypeScript
(`admin`, `backend`, `main`, `managed`, `projects`), Node-RED runtime JavaScript and
adapter TypeScript/native test files for structural measurement. Walkthrough
scripts are excluded from production counts. Nested `node_modules`, `.worktrees`
and generated data are explicitly excluded. The default Vitest discovery is
unchanged; quality tests use their own explicit configuration.

[`baseline.json`](/scripts/quality/baseline.json) records measured physical lines,
ratios, existing complexity violations, ordinary/coverage suite and file durations
in milliseconds, branch percentages and scoped mutation score. The initial
backend counts are 1369 source lines and 531 test lines. Native runtime files are
included in V8 coverage even when unexecuted by this suite; their zero coverage is
visible rather than silently omitted. Branch percentages of 100 for zero-branch
files do not imply execution coverage. Native Docker acceptance is a separate
suite, not part of this provider-free coverage measurement.

Every size/ratio increase or branch/mutation percentage decrease warns against
the baseline. New files/scores also warn so reviewers explicitly accept new scope.
Runtime warns above baseline × 1.5 + 250ms to accommodate machine/load variance.
The test wrapper has a three-minute timeout and preserves runner failures.
ESLint's classic complexity rule warns above 10, retaining inherited violations.
Per-file complexity values are ranked descending, with rank keys instead of line
numbers so moving code does not reset the baseline. This distribution ratchet can
miss equal-complexity swaps between functions; the explicit per-function ESLint
warnings remain visible in that case.

To maintain the ratchet, run these sequentially on the same checkout:

```sh
DEFAULT_MODEL=github-copilot/gpt-6-luna make check
DEFAULT_MODEL=github-copilot/gpt-6-luna make quality-coverage
DEFAULT_MODEL=github-copilot/gpt-6-luna timeout 15m make quality-mutation
npm run quality:baseline
git diff -- scripts/quality/baseline.json
```

The update takes the better of the old and new value, never silently accepting a
regression. It adds newly measured keys and removes deleted files. Review baseline
diffs with the raw reports; any deliberate regression acceptance requires an
explicit reviewed baseline edit. Do not tighten runtime from an unusually fast
outlier or compare partial test runs with a complete suite baseline.

## Mutation effectiveness and implementation choice

Stryker mutates the complete managed graph validation/generation module and runs
the five existing managed-workflow tests for every mutant. This scope exercises
API validation, native boundary wiring, versioned snapshots and CRUD rollback
assertions without adding coverage-driven production tests. The native command
runner is used: Stryker 10's optimized Vitest runner with Vitest 5 selected zero
tests for covered mutants in local validation. The reporter rejects zero-test
survivors, empty reports and pending mutants rather than recording a false score.
Command mode runs a fresh Vitest process per mutant, uses two workers, and trades
performance for verified execution. No mutation types are excluded.

Initial valid result: **258 mutants, 134 killed, 124 survived, 0 timeouts/errors;
51.94% score**, about six minutes locally. Survivors are a concrete follow-up for
review of validation boundaries and assertion effectiveness; they are not a
reason to manufacture tests merely to raise the score. HTML and JSON reports
identify mutation locations. The score applies only to `managed.ts`, not the
complete backend.

Stryker's dev-only `typed-rest-client` pins vulnerable `qs`; the root override
selects patched `qs` 6.16+ and root audit is checked during validation. This is
independent of issue #36's nested runtime dependency audit.

## Backend decomposition evaluation

The gates require no backend change. Existing seams are managed administration,
observations/finalization, and conversation/session lifecycle. The measured
complexity hotspots provide evidence for a future narrowly scoped change; splitting
them now would couple structural measurement rollout to runtime behavior changes.
Any future split should preserve native/provider acceptance and focus tests on
behavioral failures, rather than line-count or coverage targets alone.

## Tool references

- [ESLint complexity rule](https://eslint.org/docs/latest/rules/complexity)
- [Vitest coverage include/reporters](https://vitest.dev/guide/coverage)
- [Stryker configuration and command runner](https://stryker-mutator.io/docs/stryker-js/configuration/)
