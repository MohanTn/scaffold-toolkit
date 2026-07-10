# scaffold-toolkit

An npm-workspaces monorepo for `scaffold`, a deterministic, LLM-agnostic scaffolding CLI, plus the host adapters that let AI coding agents drive it.

## Packages

- `packages/core` (`@mohantn/scaffold-core`) — the portable `scaffold` CLI. Never calls an LLM: it validates an intent manifest, resolves a versioned template pack, renders Handlebars templates, injects registration snippets into existing files via paired text markers, and prints a JSON/TOON report. See `packages/core/README.md`.
- `packages/adapter-claude-code` — a Claude Code Skill (`SKILL.md`) plus `PostToolUse`/`Stop` hooks that turn natural-language requests into intent manifests, shell out to the core CLI, fill the reported `AI_IMPLEMENTATION` blocks, and refuse to end the turn while any required block is still unfilled. `private: true` (not published).
- `packages/adapter-copilot-cli` — a `gh` CLI extension exposing the same touchpoints inside Copilot Chat, with matching `postToolUse`/`agentStop` hooks registered via `gh scaffold install-hooks`.

## The deterministic loop

The CLI owns the boilerplate; the host LLM owns only the business logic. A run creates every file and injects every registration deterministically, then leaves `AI_IMPLEMENTATION` blocks for the agent to fill. Blocks a pack tags `:required` (the business-logic seams) are tracked by `scaffold status`, which exits non-zero — and the adapters' `Stop`/`agentStop` hooks block the turn — until the agent changes them. So the LLM never re-types a DTO, controller, or DI wiring; it only writes the parts a template cannot know.

Pack authors can smoke-test a local pack with a real generate (injection included, not just rendering) via `scaffold validate-pack --pack <dir> --manifest <sample>`.

Template packs (the Handlebars templates plus their `manifest.templates.json` descriptors, per target stack) live in their own separate repositories, not in this monorepo: `scaffold-templates-dotnet` and `scaffold-templates-react`.

## Setup: wiring a coding agent to `scaffold`

Both adapters are thin: they build the intent manifest and call the same `scaffold` binary. That binary must be resolvable two ways depending on caller:

- **Ad-hoc invocation** (the Claude Code Skill's per-turn `generate` calls) can use `npx -y @mohantn/scaffold-core <command>` — no install required, `npx` fetches it on first use.
- **Hook scripts** (both adapters' `PostToolUse`/`Stop`/`postToolUse`/`agentStop` hooks, and the Copilot shim's own subcommands) shell out to the literal command `scaffold` via `execFile`, not `npx`. These need `@mohantn/scaffold-core` installed so `scaffold` is actually on `PATH`:

  ```sh
  npm install -g @mohantn/scaffold-core
  scaffold --version   # confirms it resolved
  ```

  Do this once, on any machine (or CI runner) where a hook or the Copilot shim will run — skipping it doesn't break `generate`, but it silently disables the enforcement that makes phase-3 completion deterministic instead of prose-based.

### 1. Point a target repo at its template pack(s) (shared by both agents)

```sh
npx -y @mohantn/scaffold-core init --project-type <dotnet|react> --pack backend=<git-url-or-local-path>@<version>
npx -y @mohantn/scaffold-core templates sync
```

`--pack` is repeatable (`--pack backend=... --pack frontend=...` for a full-stack repo). `<version>` is a version folder in the pack repo, e.g. `v10-minimal-api` or `v8-controller-gcp` for `scaffold-templates-dotnet`, `axios-ts` or `tanstack-query` for `scaffold-templates-react`. This writes `.scaffold/config.json` and populates `.scaffold/cache/`; commit the former, gitignore the latter.

### 2a. Claude Code

`packages/adapter-claude-code` is `private: true` — it ships as source in this repo, not as an npm package, so a Claude Code Skill directory has to be installed from a checkout rather than `npm install`-ed:

1. Clone this repo somewhere stable (or keep the one you already have).
2. Symlink (or copy) the Skill directory into where Claude Code loads Skills from — `~/.claude/skills/` for every repo on the machine, or a specific repo's `.claude/skills/` to scope it there:

   ```sh
   ln -s /path/to/scaffold-toolkit/packages/adapter-claude-code ~/.claude/skills/scaffold
   ```
3. Nothing else to configure by hand: the first time the Skill runs against a given target repo, its `SKILL.md` instructs Claude to merge the `PostToolUse`/`Stop` hook entries into that repo's `.claude/settings.json` itself (locating `hooks/post-tool-use.mjs` and `hooks/stop.mjs` next to the installed `SKILL.md`, without clobbering any existing `permissions`/`mcpServers`/etc. keys).
4. Use it: ask Claude Code to scaffold something ("scaffold a new Invoice endpoint with amount and issuedAt"). It builds the intent manifest, runs `generate`, and fills only the reported `AI_IMPLEMENTATION` blocks — see `packages/adapter-claude-code/SKILL.md` for the full per-invocation workflow and failure modes.

### 2b. GitHub Copilot CLI

`packages/adapter-copilot-cli` publishes as `@mohantn/scaffold-adapter-copilot-cli` and also works as a `gh` extension. Either path puts `gh-scaffold` on `PATH`:

```sh
gh extension install <owner>/gh-scaffold          # once published as a repo named gh-scaffold
# or
npm install -g @mohantn/scaffold-adapter-copilot-cli
```

Then, once per target repo:

```sh
gh scaffold install-hooks
```

This writes `.github/hooks/scaffold-toolkit.json` registering the `postToolUse`/`agentStop` hooks with absolute paths — commit it so every teammate using Copilot CLI on the repo gets the same enforcement. `gh scaffold generate --manifest <file>` also runs a `scaffold status` precheck itself before every call, a second, independent layer that covers invocations outside a live agent session (CI, a script, a bare terminal) where no hook fires at all. See `packages/adapter-copilot-cli/README.md` for the full command reference and the two enforcement layers.

### Verifying the loop is armed

After either agent runs a `generate` that leaves a `:required` `AI_IMPLEMENTATION` block unfilled:

```sh
scaffold status --json   # or: npx -y @mohantn/scaffold-core status --json
```

should exit non-zero and list the unresolved block(s). Filling them and re-running should exit `0` — that's the same check the `Stop`/`agentStop` hooks perform before letting a turn end.

## Development

```
npm install
npm run build
npm run lint
npm test
```

## Release

Every merge to `main` runs the full test matrix, then bumps the patch version of every publishable workspace and publishes to the public npm registry. See `.github/workflows/ci.yml`.
