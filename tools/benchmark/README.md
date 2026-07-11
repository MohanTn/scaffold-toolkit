# scaffold-toolkit benchmark

A reusable, checked-in comparison of freehand vs. `scaffold`-CLI-assisted authoring of the same feature (adding an "Order" entity vertical slice to a seeded .NET solution), measuring token usage, cost, wall-clock time, and whether the result actually builds.

## What this is not

- **Not a `packages/` workspace.** Same posture as `packages/templates-dotnet`: it drives an external `claude` process plus the real dotnet toolchain together, a cross-package concern that doesn't belong inside `packages/core`'s own build/lint/test cycle.
- **Not part of CI.** `run-benchmark.mjs` spends real Anthropic API money every time it runs. It is never invoked automatically — only `fixtureRepo.test.mjs`, `metrics.test.mjs`, and `prompts.test.mjs` run in CI-safe conditions (no live API calls, no cost).

## *** COST WARNING ***

Running `npm run benchmark` from the repo root (or `node tools/benchmark/run-benchmark.mjs` directly) spawns **two live `claude -p` sessions** against the real Anthropic API, one per arm. Each is capped at `--max-budget-usd` (default `$2`, override via the `SCAFFOLD_BENCHMARK_MAX_BUDGET_USD` environment variable), but that cap is per arm, not total, and is enforced by the `claude` CLI itself, not by this script. Do not run this in a loop, in CI, or unattended.

## How it works

1. `fixtureRepo.mjs` builds one shared base repo: `scaffold init` against a local-path pack spec for `packages/templates-dotnet/v8-controller`, `scaffold templates sync`, then one real `scaffold generate` for a seed entity ("Seed", distinct from the benchmarked "Order" entity) to materialize the full solution skeleton — `.sln`, `Program.cs` with markers, `AppDbContext`, etc. Both arms get a byte-identical copy of this base (`copyBaseRepo`), so the comparison is about per-feature boilerplate cost, not project bootstrapping.
2. Both arms (`arms/freehand.mjs`, `arms/scaffolded.mjs`) drive `claude -p "<prompt>" --output-format json --permission-mode acceptEdits --max-budget-usd <cap>` against their own copy:
   - **freehand**: the prompt (`prompts.mjs`) explicitly forbids using the `scaffold` CLI, and the CLI is also stripped from `PATH` for that arm's spawned process — the prompt instruction alone isn't trusted as the only guardrail.
   - **scaffolded**: `scaffold` (the built CLI, via a shell wrapper) is on `PATH`, and the prompt follows the real `SKILL.md` workflow: build an intent manifest, run `generate`, fill only the reported `AI_IMPLEMENTATION` blocks.
3. `metrics.mjs` extracts cost/token/duration/turn-count fields from each arm's `--output-format json` result, plus an independently-measured wall-clock time around the `spawnSync` call.
4. `fixtureRepo.mjs`'s `dotnetBuild` runs a real `dotnet restore` + `dotnet build` against each arm's resulting repo.
5. `run-benchmark.mjs` writes `results/<timestamp>/summary.md` with both arms' numbers side by side.

## Field-shape caveat

The exact field names inside `--output-format json`'s result object (`total_cost_usd`, `usage.{input,output}_tokens`, `duration_ms`, `num_turns`) are the widely-documented shape, **not independently re-verified against a live call** during this feature's implementation (deliberately not spent). Before trusting a real benchmark run's numbers, run one throwaway `claude -p "say hi" --output-format json` by hand, inspect the actual payload, and correct `metrics.mjs` if the field names differ.

## Running it for real

```
npm run benchmark
```

(from the repo root; requires `packages/core` already built — `npm run build` — and both `claude` and `dotnet` on `PATH`). Inspect `tools/benchmark/results/<timestamp>/summary.md` afterward and sanity-check the numbers look plausible — e.g. the scaffolded arm should show meaningfully lower token usage than freehand, and both arms' `dotnet build` should ideally read `PASS`. A `FAIL` isn't necessarily a harness bug; it's a real, graded outcome for that arm's attempt.

## Tests

```
npm test
```

(from `tools/benchmark/`, or via the repo root's own test runner if it's ever wired in — currently it is not, deliberately, since `fixtureRepo.test.mjs` needs the .NET SDK on `PATH` and this directory sits outside the root `workspaces` array). Three suites:

| Suite | What it covers | External deps | Spends money? |
|---|---|---|---|
| `fixtureRepo.test.mjs` | Really builds the base repo via the real `scaffold` CLI + `dotnet build`, and that `copyBaseRepo` produces an independent copy | `dotnet` on PATH, `packages/core` built | No |
| `metrics.test.mjs` | Pure extractor tests against the checked-in recorded sample result blob (`test/fixtures/sample-claude-result.json`) | none | No |
| `prompts.test.mjs` | Pure string assertions on both arms' generated prompt text | none | No |

`run-benchmark.mjs` itself is manual-only — there is no automated test that invokes it, by design.
