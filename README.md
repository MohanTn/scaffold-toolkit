# scaffold-toolkit

An npm-workspaces monorepo for `scaffold`, a deterministic, LLM-agnostic scaffolding CLI, plus the host adapters that let AI coding agents drive it.

## Packages

- `packages/core` (`@mohantn/scaffold-core`) — the portable `scaffold` CLI. Never calls an LLM: it validates an intent manifest, resolves a versioned template pack, renders Handlebars templates, injects registration snippets into existing files via paired text markers, and prints a JSON/TOON report. See `packages/core/README.md`.
- `packages/adapter-claude-code` — a Claude Code Skill (`SKILL.md`) plus `PostToolUse`/`Stop` hooks that turn natural-language requests into intent manifests, shell out to the core CLI, fill the reported `AI_IMPLEMENTATION` blocks, and refuse to end the turn while any required block is still unfilled. `private: true` (not published).
- `packages/adapter-copilot-cli` — a `gh` CLI extension exposing the same touchpoints inside Copilot Chat, with matching `postToolUse`/`agentStop` hooks registered via `gh scaffold install-hooks`.

## The deterministic loop

The CLI owns the boilerplate; the host LLM owns only the business logic. A run creates every file and injects every registration deterministically, then leaves `AI_IMPLEMENTATION` blocks for the agent to fill. Blocks a pack tags `:required` (the business-logic seams) are tracked by `scaffold status`, which exits non-zero — and the adapters' `Stop`/`agentStop` hooks block the turn — until the agent changes them. So the LLM never re-types a DTO, controller, or DI wiring; it only writes the parts a template cannot know.

Pack authors can smoke-test a local pack with a real generate (injection included, not just rendering) via `scaffold validate-pack --pack <dir> --manifest <sample>`.

Template packs (the Handlebars templates plus their `manifest.templates.json` descriptors, per target stack) live in their own standalone repositories — `scaffold-templates-dotnet` and `scaffold-templates-react` — which remain the source of truth for real consumption. `packages/templates-dotnet` in this monorepo is a separate, in-repo copy of the `.NET` pack's *current file state* (not its git history), kept purely so `scaffold generate`/`templates sync` can be exercised end-to-end during `scaffold-core` development without a second repo checked out on disk; it is deliberately left out of the `workspaces` array below, so CI never builds, lints, or publishes it, and it does not auto-sync with the standalone repo. See "Building template packs" below for the full authoring workflow, including adding a pack for a new framework/stack or extending an existing one for a new cloud provider.

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

## Building template packs

A template pack is a versioned folder of Handlebars templates plus a `manifest.templates.json` descriptor that `scaffold generate` renders against a host-supplied intent manifest. `packages/core` never knows anything about a specific stack — it only knows the descriptor schema: `targets[]` (files to render), `injections[]` (marker-based snippets to splice into existing files), `pathConfig` (named path fragments a manifest can override), `requires.scaffoldCli` (a semver range checked against the installed CLI before anything renders), and an optional pack-local `helpers.js`. `packages/templates-dotnet/v8-controller` is the reference example for everything below; read its `manifest.templates.json` and any `.hbs` file alongside this section.

### Adding a new template pack for a different framework (e.g. React)

1. **Decide where it lives.** A standalone repo (mirroring `scaffold-templates-dotnet`/`scaffold-templates-react`) is the source of truth for real consumption — that's what a target project's `.scaffold/config.json` should point `packs.<name>.url` at. Optionally also mirror its current files into `packages/templates-<name>` here (not added to the root `workspaces` array) purely for exercising `scaffold-core` locally without a second repo checkout; see the `packages/templates-dotnet` note above for what that copy is and isn't.
2. **Create a version folder**, e.g. `v1-vite-axios/`, containing:
   - `manifest.templates.json` — `descriptorSchemaVersion` (currently `2`), `packVersion`, `requires.scaffoldCli`, `pathConfig`, `targets[]` (each: `output` — a Handlebars path template like `src/{{pathConfig.features}}/{{entity}}/{{entity}}Api.ts`; `template` — the `.hbs` file; `mode` — `create` refuses if the file already exists, `skip-if-exists` renders once for shared/bootstrap files and is never touched again), and `injections[]` (each: `file`, `marker`, `template`, `position` — `before-end`/`after-start`, `strategy` — `replace`/`append`, `hashTrailerPrefix` — the idempotency hash comment prefix compared on every re-run).
   - One `.hbs` file per target/injection. Templates render against the manifest's `entity`/`fields`/`options` and the whole manifest itself (`options` spread first, then the full manifest, so a top-level manifest key wins over a same-named `options` key — see `buildHandlebarsContext` in `packages/core/src/generate/generate.ts`).
   - An optional `helpers.js` next to the descriptor, exporting `{ register(handlebars) { handlebars.registerHelper(...) } }` — loaded automatically before any template in that version renders (`packages/core/src/generate/packHelpers.ts`). Use it for stack-specific casing/pluralization/naming helpers; the engine's own built-ins (`pascal`, `camel`, `snake`, `kebab`, `upper`, `lower`) are generic, not stack-aware.
3. **Write `test_data/` fixtures** — one manifest per distinct scenario the pack should support (a different entity shape, a different feature type, whatever varies meaningfully), not a near-duplicate copy of the same entity repeated across many files. Each fixture is a complete, standalone intent manifest a real user or agent might actually send.
4. **Write a build-check script**, mirroring `packages/templates-dotnet/tools/validate-build.mjs`: scaffold every `test_data` fixture (deduplicated by whatever "these two would collide" key applies — `entity` for the .NET pack) through the real `scaffold generate` CLI into a throwaway sample project, then actually build/test that project with the stack's own toolchain (`npm install && npm run build && npm test` for a Node/React pack — not just "did `generate` throw"). This is the step that matters: a template can render syntactically valid, semantically broken code (wrong import, wrong method name, mismatched types), and neither Handlebars rendering nor `scaffold validate-pack` will ever notice — only actually building/testing the output does.
5. **Wire it into CI** as its own job (see `.github/workflows/ci.yml`'s `templates-dotnet-build-check` for the shape: checkout, whatever toolchain setup the stack needs, build `packages/core`, run the script), and add that job to the `publish` job's `needs:` list so a broken pack can never reach npm.

### Extending an existing pack for a new target (e.g. a cloud provider)

Two patterns, chosen by how big the divergence is:

- **Manifest-option conditional, same version** — for a config-only swap (a connection string, a package reference), branch inside the existing templates on a manifest `options` field, the way `packages/templates-dotnet/v8-controller/InfrastructureCsproj.hbs` and `InfrastructureDependencyInjection.cs.hbs` already do for `options.database.provider` (`{{#if (eq options.database.provider "postgres")}}...{{else}}...{{/if}}`, switching between Npgsql and SQLite). No new version folder, no new files.
- **New, additive version folder** — for a real architectural addition (new files, new registrations), create a sibling version directory (e.g. `v8-controller-gcp` next to `v8-controller`) with its own `manifest.templates.json` declaring only the *additional* targets/injections, using marker names that don't collide with the base version's (the base pack's `Program.cs` injection uses marker `DI`; a GCP add-on wiring in Pub/Sub or Secret Manager would declare its own markers, e.g. `PUBSUB`/`GSM`, so a target project can run `scaffold init`/`generate` against `v8-controller` and then again against `v8-controller-gcp` without conflict). `packages/core/src/bootstrapMarkers`'s marker catalog already models packs this way, keyed by exact pack version rather than a coarse stack name, precisely so a base pack and its cloud-provider sibling can carry different marker sets.

Either way, the same rule applies without exception: **new `test_data` fixtures and a passing build-check for every new or extended version are required, gated in CI before publish.** An additive version is exactly as capable of shipping a namespace typo or a missing `using` as a brand-new pack is, and it inherits zero automatic protection from the base version's own tests — each version needs its own end of the pipeline validating it compiles for real.

## Development

```
npm install
npm run build
npm run lint
npm test
```

## Release

Every merge to `main` runs the full test matrix, then bumps the patch version of every publishable workspace and publishes to the public npm registry. See `.github/workflows/ci.yml`.
