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

Run once per repo. Writes `.github/hooks/scaffold-toolkit.json`, registering this package's `postToolUse` and `agentStop` hooks with Copilot CLI (schema: https://docs.github.com/en/copilot/reference/hooks-reference). Repo-level, not `~/.copilot/hooks/`, so it's committed and applies to every teammate using Copilot CLI on the repo automatically — the same one-time-per-repo model the Claude Code adapter's `SKILL.md` uses when it registers hooks into a target repo's `.claude/settings.json`. Re-running after a package upgrade is safe: it overwrites the file with the (possibly new) absolute script paths, deterministically.

### `gh scaffold status`

Runs `scaffold status --json` in the target directory. Exits `0` when every previously-recorded `AI_IMPLEMENTATION` block is resolved; exits `1` and prints the unresolved block list otherwise. With `--json`, prints the full `{ resolvedAll, unresolved }` object on stdout for tool parsing.

### `gh scaffold generate`

Runs the `scaffold status --json` precheck first. If any block is still pending, the shim **refuses (exit `1`)** and prints the pending block list. This precheck is a second, independent layer on top of the `agentStop` hook (see below): the hook only fires inside a live Copilot agent session, while this precheck also covers `gh scaffold generate` invoked directly — CI, a script, a bare terminal — outside one. If the precheck is clean, the shim runs `scaffold generate --manifest <file>` and streams its TOON-formatted report to stdout verbatim.

Pass-through flags `--dry-run` and `--force` are forwarded to `scaffold-core` after the manifest argument (see `buildGeneratePassthrough` in `src/index.mjs`). `--json` is **not** forwarded: the shim consumes its own `--json` to choose the format of its *own* precheck-blocked envelope, which is a separate concern from `scaffold-core`'s report wire format (TOON by default) on the success path. `--cwd` defaults to `process.cwd()`.

### `gh scaffold --version`

Prints the installed shim version.

## Two independent enforcement layers

GitHub Copilot CLI has supported lifecycle hooks since its GA in February 2026 (`.github/hooks/*.json`, events including `postToolUse` and `agentStop`) — an earlier draft of this package predated that and described Copilot CLI as hooks-less; that's no longer accurate.

1. **`agentStop` hook (`hooks/agent-stop.mjs`), installed via `gh scaffold install-hooks`.** Runs `scaffold status --json` before the agent's turn is allowed to end; if any `AI_IMPLEMENTATION` block is still pending, it returns `{ decision: "block", reason }`, the same hard, un-skippable guarantee Claude Code's `Stop` hook gives. This is the load-bearing mechanism, live within a Copilot agent session.
2. **`generate` precheck**, always active, no install step needed. Refuses to start a *new* `generate` call while a prior changeset has unresolved blocks. This is what covers invocations of `gh scaffold generate` outside a live agent session (CI, a script, a bare terminal), where no hook fires at all.

There's also `hooks/post-tool-use.mjs` (installed by the same `install-hooks` command), a `postToolUse` soft nudge mirroring Claude Code's `PostToolUse` hook: it doesn't block anything (that event fires after the tool already ran), it just surfaces the pending list as `additionalContext` right after a `scaffold generate` call, before the agent even reaches the end of its turn.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Subcommand succeeded / precheck found nothing pending |
| 1 | Precheck blocked, scaffold binary unreachable, or `scaffold-core` exited non-zero |
| 2 | Usage error (unknown subcommand, missing `--manifest`) |

## What this shim does *not* do

- **Build the intent manifest.** The Copilot Chat session is responsible for that, exactly as the Claude Code Skill instructs Claude. The published manifest schema and TOON/JSON wire format are the same with both adapters.
- **Fill `AI_IMPLEMENTATION` blocks.** Copilot Chat uses its own file-editing tool, just like Claude Code's Edit tool. The shim only needs to expose the unresolved list (via `status` and the `generate` precheck refusal) so a second turn knows what to fill.
- **Edit anything in the target repo.** It's a thin orchestrator on top of `scaffold-core`. The reported `content` field per `AI_IMPLEMENTATION` entry is what the host agent uses to locate each block in its own file editor.

## Manual verification (end to end)

1. From the monorepo root: `npm install` (workspace link) and `npm run build` (so `scaffold` is on `PATH`).
2. Create a fresh throwaway repo fixture, e.g. under `/tmp/scaffold-fixture/`.
3. In the fixture: `npx @mohantn/scaffold-core init --project-type dotnet --pack backend=<local-path to scaffold-templates-dotnet>` and `npx @mohantn/scaffold-core templates sync`.
4. Run `gh scaffold install-hooks` once, then confirm `.github/hooks/scaffold-toolkit.json` was written with absolute paths to `hooks/post-tool-use.mjs` and `hooks/agent-stop.mjs`.
5. With `gh-scaffold` on `PATH`, run `gh scaffold generate --manifest <sample>.toon` and inspect the TOON report on stdout.
6. With `AI_IMPLEMENTATION` blocks deliberately left unfilled, run `gh scaffold generate --manifest <sample>.toon` again and confirm exit `1` with the pending list on stderr (the precheck layer).
7. Inside a live Copilot CLI agent session in the fixture repo, attempt to end the turn with a block still unfilled and confirm the `agentStop` hook blocks it (the hook layer) — this step needs a real Copilot CLI session and can't be driven headlessly; `test/installHooks.test.mjs` exercises the same hook scripts synthetically instead.
8. Fill the blocks (the Copilot equivalent of the Claude Code Edit step), then re-run `gh scaffold generate` and confirm exit `0`.

## Tests

```
npm test
```

Six suites, all picked up by `node --test test/*.test.mjs`:

| Suite | What it covers | External deps |
|---|---|---|
| `precheck.test.mjs` | Pure-function decision logic (`buildPrecheckDecision` × every input shape, `renderPendingText`) | none |
| `dispatch.test.mjs` | Subcommand-level dispatch: parser, exit codes, blocked-precheck IO branch, `buildGeneratePassthrough` | none — `process.env.PATH` overridden to force `scaffold` unreachable |
| `bin-smoke.test.mjs` | Spawns the actual `bin/gh-scaffold` via `child_process.execFile`; catches import-extension bugs (e.g. `../src/index.js` against a `src/index.mjs` file) that the rest of the suite cannot detect because the test runner imports `src/index.mjs` directly and bypasses the bin entry | none |
| `end-to-end.test.mjs` | Mirrors the README's manual-verification recipe end to end: builds a real fixture template pack (`mkdtempSync + git init + write Handlebars templates + git commit`), `scaffold init` + `scaffold templates sync`, then drives `gh scaffold status` / `gh scaffold generate` through the actual shim binary against the produced fixture target. Verifies precheck refusal (exit 1, pending list on stderr, file mtime unchanged), `--dry-run` passthrough (no disk write), block fill, and post-fill re-resolution | `git` on PATH, scaffold-core `dist/cli.js` built (`npm run build`) |
| `hookPostToolUse.test.mjs` / `hookAgentStop.test.mjs` | Pure decision-function tests for the two Copilot hook scripts, against the exact input/output shapes in the hooks-reference schema | none |
| `installHooks.test.mjs` | Unit tests for `buildHooksConfig`/`resolveHookScriptPaths`/`installHooks`, plus a full integration test: `install-hooks` against a fixture repo, then spawning the two written hook scripts with synthetic Copilot-shaped stdin to prove the nudge-while-pending → block-while-pending → allow-once-filled chain works end to end | `git` on PATH, scaffold-core `dist/cli.js` built |

Both the bin-smoke and end-to-end tests shell out via `child_process.execFile` rather than mocking — no mocking libraries are used anywhere in the shim's test suite. The end-to-end test resolves `scaffold` on PATH inside each child process via a private shell wrapper in a tmpdir (see `test/_harness.mjs`), so it does NOT require a global `npm link` or a `gh extension install` to run in CI.
