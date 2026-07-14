# @mohantn/scaffold-adapter-copilot-cli

A `gh` CLI extension shim that lets GitHub Copilot CLI drive `@mohantn/scaffold-core` for deterministic, LLM-agnostic scaffolding.

## Install

### As a `gh` extension (recommended)

```
gh extension install <owner>/gh-scaffold
```

(Name the GitHub repo `gh-scaffold` to match the binary name. `gh` looks for `bin/gh-<extension>` at the repo root.)

### As an npm package

```
npm install -g @mohantn/scaffold-adapter-copilot-cli
```

Either path puts `gh-scaffold` on `PATH`.

## Prereq

`@mohantn/scaffold-core` (`scaffold` binary) must be installed and on `PATH`. The shim is a thin orchestrator on top of it; the host-portable scaffolding work is the core's job, exactly as with the Claude Code adapter.

## Commands

```
gh scaffold [--help]
gh scaffold --version
gh scaffold install-hooks [--cwd <dir>]
gh scaffold status [--cwd <dir>] [--json]
gh scaffold generate --manifest <file> [--cwd <dir>] [--dry-run] [--force] [--json]
```

### `gh scaffold install-hooks`

Run once per repo. Writes `.github/hooks/scaffold-toolkit.json`, registering this package's `preToolUse`, `postToolUse`, and `agentStop` hooks with Copilot CLI (schema: https://docs.github.com/en/copilot/reference/hooks-reference). Repo-level, not `~/.copilot/hooks/`, so it's committed and applies to every teammate using Copilot CLI on the repo automatically — the same one-time-per-repo model the Claude Code adapter's `SKILL.md` uses when it registers hooks into a target repo's `.claude/settings.json`. Re-running after a package upgrade is safe: it overwrites the file with the (possibly new) absolute script paths, deterministically.

**`preToolUse` (`hooks/pre-tool-use.mjs`) ships with a `*** VERIFY BEFORE SHIP — HIGH RISK ***` caveat**: its `toolName`/`toolArgs` field-shape assumptions for a file write/edit are a guess, not a payload confirmed against a live Copilot CLI session — see the script's own header comment. Treat it as unverified until that live check has run.

### `gh scaffold status`

Runs `scaffold status --json` in the target directory. Exits `0` when every previously-recorded `AI_IMPLEMENTATION` block is resolved; exits `1` and prints the unresolved block list otherwise. With `--json`, prints the full `{ resolvedAll, unresolved }` object on stdout for tool parsing.

### `gh scaffold generate`

Runs the `scaffold status --json` precheck first. If any block is still pending, the shim **refuses (exit `1`)** and prints the pending block list. This precheck is a second, independent layer on top of the `agentStop` hook (see below): the hook only fires inside a live Copilot agent session, while this precheck also covers `gh scaffold generate` invoked directly — CI, a script, a bare terminal — outside one. If the precheck is clean, the shim runs `scaffold generate --manifest <file>` and streams its TOON-formatted report to stdout verbatim.

Pass-through flags `--dry-run` and `--force` are forwarded to `scaffold-core` after the manifest argument (see `buildGeneratePassthrough` in `src/index.mjs`). `--json` is **not** forwarded: the shim consumes its own `--json` to choose the format of its *own* precheck-blocked envelope, which is a separate concern from `scaffold-core`'s report wire format (TOON by default) on the success path. `--cwd` defaults to `process.cwd()`.

### `gh scaffold --version`

Prints the installed shim version.

## Three independent enforcement layers

GitHub Copilot CLI has supported lifecycle hooks since its GA in February 2026 (`.github/hooks/*.json`, events including `preToolUse`, `postToolUse`, and `agentStop`) — an earlier draft of this package predated that and described Copilot CLI as hooks-less; that's no longer accurate.

1. **`preToolUse` hook (`hooks/pre-tool-use.mjs`), installed via `gh scaffold install-hooks`.** The hard gate on direct writes/edits: fires *before* a file-write/edit tool call runs and shells out to `scaffold check-edit` (in `@mohantn/scaffold-core`) to decide whether the target is a pack-owned file being written directly, or edited outside an `AI_IMPLEMENTATION` interior — if so, it blocks with `{ permissionDecision: "deny", permissionDecisionReason }`. This mirrors the Claude Code adapter's `PreToolUse` hook and is the only layer that can stop a hand-written, un-scaffolded file from reaching disk at all. **Its input-field assumptions are unverified — see the "install-hooks" section above.**
2. **`agentStop` hook (`hooks/agent-stop.mjs`), installed via `gh scaffold install-hooks`.** Runs `scaffold status --json` before the agent's turn is allowed to end; if any `AI_IMPLEMENTATION` block is still pending, it returns `{ decision: "block", reason }`, the same hard, un-skippable guarantee Claude Code's `Stop` hook gives. This is the load-bearing mechanism for phase-3 completion, live within a Copilot agent session.
3. **`generate` precheck**, always active, no install step needed. Refuses to start a *new* `generate` call while a prior changeset has unresolved blocks. This is what covers invocations of `gh scaffold generate` outside a live agent session (CI, a script, a bare terminal), where no hook fires at all.

There's also `hooks/post-tool-use.mjs` (installed by the same `install-hooks` command), a `postToolUse` soft nudge mirroring Claude Code's `PostToolUse` hook: it doesn't block anything (that event fires after the tool already ran), it just surfaces the pending list as `additionalContext` right after a `scaffold generate` call, before the agent even reaches the end of its turn.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Subcommand succeeded / precheck found nothing pending |
| 1 | Precheck blocked, scaffold binary unreachable, or `scaffold-core` exited non-zero |
| 2 | Usage error (unknown subcommand, missing `--manifest`) |

## Commands this shim doesn't wrap (call `scaffold` directly)

`gh scaffold` wraps only `status`/`generate`/`install-hooks` — the generate-then-must-fill-blocks loop its precheck and hooks exist to protect. Three more `scaffold-core` subcommands are commonly useful in a Copilot Chat session but need no shim orchestration, so call the `scaffold` binary directly (same `PATH` prerequisite as this shim):

- **`scaffold next [--json]`** — after `generate`, reshapes the same rescan `gh scaffold status` uses into a compact digest of still-open `AI_IMPLEMENTATION` work: `{ done, blocks: [{ file, startLine, endLine, required, placeholder }] }`. Use it in a later turn to re-orient on Phase-3 fill-in work without re-reading every generated file — `placeholder` is the block's exact current interior, usable the same way as `generate`'s report `content` field to locate the block in your own file editor. Exits `0` when `done`, `1` otherwise.
- **`scaffold bootstrap-markers [--dry-run] [--json]`** — one-time-per-repo brownfield adoption, run before the first `generate` on a repo that already has hand-written code a configured pack should now own. Maps the pack's `targets[]`/`injections[]` to the repo's real files (persisted to `.scaffold/config.json`'s `adoptedPaths`, gated by `preToolUse`/`check-edit` exactly like generated files) and bootstraps empty `SCAFFOLD:<marker>:START/END` pairs where an anchor is known. Run `--dry-run` first. In the report, treat `pendingGenerate` as informational (the anchor file is itself a `generate` target and arrives with its marker pair already placed — nothing to do by hand) and `needsManual` as something to surface to the user rather than guess at (genuinely ambiguous: zero or multiple candidate files). Exits `1` while any `needsManual`/`mappingNeedsManual` entries remain.
- **`scaffold pack new --dir <path> --pack-version <version> [--stack <label>]`** — pack-authoring, not pack-consuming. Scaffolds an empty, schema-valid `manifest.templates.json` plus a `tools/validate-build.mjs` stub for a brand-new template pack. Only relevant if the user wants support for a stack no configured pack covers yet; the author still adds real `.hbs` templates, `test_data/` fixtures, and a real build-check by hand afterward.

## What this shim does *not* do

- **Build the intent manifest.** The Copilot Chat session is responsible for that, exactly as the Claude Code Skill instructs Claude. The published manifest schema and TOON/JSON wire format are the same with both adapters.
- **Fill `AI_IMPLEMENTATION` blocks.** Copilot Chat uses its own file-editing tool, just like Claude Code's Edit tool. The shim only needs to expose the unresolved list (via `status` and the `generate` precheck refusal) so a second turn knows what to fill.
- **Edit anything in the target repo.** It's a thin orchestrator on top of `scaffold-core`. The reported `content` field per `AI_IMPLEMENTATION` entry is what the host agent uses to locate each block in its own file editor.

## Manual verification (end to end)

1. From the monorepo root: `npm install` (workspace link) and `npm run build` (so `scaffold` is on `PATH`).
2. Create a fresh throwaway repo fixture, e.g. under `/tmp/scaffold-fixture/`.
3. In the fixture: `npx @mohantn/scaffold-core init --project-type dotnet --pack backend=<local-path to scaffold-templates-dotnet>` and `npx @mohantn/scaffold-core templates sync`.
4. Run `gh scaffold install-hooks` once, then confirm `.github/hooks/scaffold-toolkit.json` was written with absolute paths to `hooks/pre-tool-use.mjs`, `hooks/post-tool-use.mjs`, and `hooks/agent-stop.mjs`.
5. With `gh-scaffold` on `PATH`, run `gh scaffold generate --manifest <sample>.toon` and inspect the TOON report on stdout.
6. With `AI_IMPLEMENTATION` blocks deliberately left unfilled, run `gh scaffold generate --manifest <sample>.toon` again and confirm exit `1` with the pending list on stderr (the precheck layer).
7. Inside a live Copilot CLI agent session in the fixture repo: (a) attempt a raw file write to a pack-owned path and confirm `preToolUse` blocks it — **this is also the step that resolves the open verification question on `pre-tool-use.mjs`'s guessed field shape; capture the real payload here and correct the hook if the guess was wrong**; (b) attempt to end the turn with a block still unfilled and confirm the `agentStop` hook blocks it. Both need a real Copilot CLI session and can't be driven headlessly; `test/installHooks.test.mjs` and `test/hookPreToolUse.test.mjs` exercise the same hook scripts synthetically instead, against the guessed shape.
8. Fill the blocks (the Copilot equivalent of the Claude Code Edit step), then re-run `gh scaffold generate` and confirm exit `0`.

## Tests

```
npm test
```

Seven suites, all picked up by `node --test test/*.test.mjs`:

| Suite | What it covers | External deps |
|---|---|---|
| `precheck.test.mjs` | Pure-function decision logic (`buildPrecheckDecision` × every input shape, `renderPendingText`) | none |
| `dispatch.test.mjs` | Subcommand-level dispatch: parser, exit codes, blocked-precheck IO branch, `buildGeneratePassthrough` | none — `process.env.PATH` overridden to force `scaffold` unreachable |
| `bin-smoke.test.mjs` | Spawns the actual `bin/gh-scaffold` via `child_process.execFile`; catches import-extension bugs (e.g. `../src/index.js` against a `src/index.mjs` file) that the rest of the suite cannot detect because the test runner imports `src/index.mjs` directly and bypasses the bin entry | none |
| `end-to-end.test.mjs` | Mirrors the README's manual-verification recipe end to end: builds a real fixture template pack (`mkdtempSync + git init + write Handlebars templates + git commit`), `scaffold init` + `scaffold templates sync`, then drives `gh scaffold status` / `gh scaffold generate` through the actual shim binary against the produced fixture target. Verifies precheck refusal (exit 1, pending list on stderr, file mtime unchanged), `--dry-run` passthrough (no disk write), block fill, and post-fill re-resolution | `git` on PATH, scaffold-core `dist/cli.js` built (`npm run build`) |
| `hookPreToolUse.test.mjs` | Pure decision-function tests for `hooks/pre-tool-use.mjs`, **against the unverified guessed `toolName`/`toolArgs` shape** (see the hook's header comment), plus a real end-to-end run of the script against a synced fixture repo proving its *logic* (block-on-write, allow-on-in-interior-edit) is internally consistent given that assumed shape | `git` on PATH, scaffold-core `dist/cli.js` built |
| `hookPostToolUse.test.mjs` / `hookAgentStop.test.mjs` | Pure decision-function tests for the `postToolUse`/`agentStop` Copilot hook scripts, against the exact input/output shapes in the hooks-reference schema | none |
| `installHooks.test.mjs` | Unit tests for `buildHooksConfig`/`resolveHookScriptPaths`/`installHooks`, plus a full integration test: `install-hooks` against a fixture repo, then spawning the three written hook scripts with synthetic Copilot-shaped stdin to prove the block-on-write/allow-on-edit (`preToolUse`) → nudge-while-pending (`postToolUse`) → block-while-pending → allow-once-filled (`agentStop`) chain works end to end | `git` on PATH, scaffold-core `dist/cli.js` built |

Both the bin-smoke and end-to-end tests shell out via `child_process.execFile` rather than mocking — no mocking libraries are used anywhere in the shim's test suite. The end-to-end test resolves `scaffold` on PATH inside each child process via a private shell wrapper in a tmpdir (see `test/_harness.mjs`), so it does NOT require a global `npm link` or a `gh extension install` to run in CI.
