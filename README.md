# scaffold-toolkit

[![npm version](https://img.shields.io/npm/v/@mohantn/scaffold-core.svg)](https://www.npmjs.com/package/@mohantn/scaffold-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 20.12](https://img.shields.io/badge/Node.js-%3E%3D%2020.12-brightgreen)](https://nodejs.org/)

A deterministic, LLM-agnostic scaffolding CLI that generates boilerplate code while letting AI coding agents focus exclusively on business logic. Includes adapters for Claude Code and GitHub Copilot CLI.

**Use scaffold when you want to:**
- Generate consistent, validated boilerplate (DTOs, controllers, services) across projects
- Enforce architectural patterns through template-based code generation
- Integrate deterministic code generation into AI coding agent workflows
- Support multiple frameworks (.NET, React) without writing stack-specific logic in the agent

## Quick start

```sh
# Install the CLI globally (used by hook scripts and the Copilot adapter)
npm install -g @mohantn/scaffold-core
scaffold --version

# Or use ad-hoc via npx (no install required)
npx -y @mohantn/scaffold-core --help
```

For detailed setup with Claude Code or GitHub Copilot CLI, see [Setup: wiring a coding agent to scaffold](#setup-wiring-a-coding-agent-to-scaffold) below.

**Want to contribute?** See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## Packages

| Package | Purpose | Published |
|---------|---------|-----------|
| [`packages/core`](#packagescoremohantnscaffold-core) | The portable `scaffold` CLI — validates manifests, resolves template packs, renders Handlebars, injects code snippets | ✅ [@mohantn/scaffold-core](https://www.npmjs.com/package/@mohantn/scaffold-core) |
| `packages/adapter-claude-code` | Claude Code Skill + hooks for natural-language → boilerplate generation | ⊘ Private (source only) |
| `packages/adapter-copilot-cli` | GitHub Copilot CLI extension + `gh` subcommand | ✅ [@mohantn/scaffold-adapter-copilot-cli](https://www.npmjs.com/package/@mohantn/scaffold-adapter-copilot-cli) |

### packages/core (@mohantn/scaffold-core)

The core CLI never calls an LLM. It validates an intent manifest, resolves a versioned template pack, renders Handlebars templates, injects registration snippets into existing files via paired text markers, and prints a JSON report. See `packages/core/README.md` for the full command reference.

## The deterministic loop

The CLI owns the boilerplate; the host LLM owns only the business logic. A run creates every file and injects every registration deterministically, then leaves `AI_IMPLEMENTATION` blocks for the agent to fill. Blocks a pack tags `:required` (the business-logic seams) are tracked by `scaffold status`, which exits non-zero — and the adapters' `Stop`/`agentStop` hooks block the turn — until the agent changes them. So the LLM never re-types a DTO, controller, or DI wiring; it only writes the parts a template cannot know.

Pack authors can smoke-test a local pack with a real generate (injection included, not just rendering) via `scaffold validate-pack --pack <dir> --manifest <sample>`.

Template packs (the Handlebars templates plus their `manifest.templates.json` descriptors, per target stack) are versioned folders `scaffold generate` reads directly off disk via a local-directory pack entry — no git clone involved. `packages/templates-dotnet` in this monorepo is the `.NET` pack's real, live working-tree copy and the source of truth for actual consumption here (`--pack backend=packages/templates-dotnet@<version>`); it is deliberately left out of the `workspaces` array below, so CI never builds, lints, or publishes it as a workspace package, but it is still exercised for real by `scaffold generate`/`validate-pack`/`bootstrap-markers`, not just for local dry-runs. The underlying git-URL pack engine (`templates sync` cloning a remote into a cache) stays available for a hypothetical future non-vendored pack, but nothing in this repo uses it today. See "Building template packs" below for the full authoring workflow, including adding a pack for a new framework/stack or extending an existing one for a new cloud provider.

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
npx -y @mohantn/scaffold-core init --project-type <dotnet|react> --pack backend=packages/templates-dotnet@<version>
npx -y @mohantn/scaffold-core templates sync
```

`--pack` takes a local-directory spec, `name=<path>@<version>` — no git URL, `scaffold init` rejects one outright with a pointer to this syntax. It's repeatable (`--pack backend=... --pack frontend=...` for a full-stack repo). `<version>` is a version folder in the pack directory, e.g. `v10-minimal-api` or `v8-controller-gcp` for `packages/templates-dotnet`. This writes `.scaffold/config.json`; `templates sync` is a no-op for a local-directory pack (there's nothing to clone or cache — it's read straight off disk on every `generate`), but still safe to run as part of the same muscle-memory recipe.

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

1. **Decide where it lives.** A local directory (e.g. `packages/templates-<name>` here, not added to the root `workspaces` array) is the normal source of truth for real consumption — that's what a target project's `.scaffold/config.json` should point `packs.<name>.path` at, e.g. `packages/templates-react`. A standalone git repo consumed via `packs.<name>.url` remains supported underneath for a hypothetical future non-vendored pack, but `scaffold init` itself only ever emits `path` entries; see the `packages/templates-dotnet` note above for what an in-repo pack copy is.
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

## Template packs

Pre-built template packs for common frameworks. This monorepo consumes the .NET pack directly from its in-repo copy at `packages/templates-dotnet` (a local-directory pack, `--pack backend=packages/templates-dotnet@<version>`); the standalone repos below are the original, publicly browsable sources these in-repo copies are periodically updated from by hand:

- **[scaffold-templates-dotnet](https://github.com/MohanTn/scaffold-templates-dotnet)** — .NET/C# (ASP.NET Core, Entity Framework, dependency injection patterns)
- **[scaffold-templates-react](https://github.com/MohanTn/scaffold-templates-react)** — React/TypeScript (API clients, hooks, component scaffolds)

Each pack ships with test fixtures and build-check scripts that validate generated code actually compiles and tests pass.

To author a new pack or extend an existing one for a new cloud provider, see [Building template packs](#building-template-packs) below.

## Development

```
npm install
npm run build
npm run lint
npm test
```

All workspaces are built, linted, and tested together. The root `package.json` scripts run against all packages with `--workspaces --if-present`.

## Contributing

Contributions are welcome. Please ensure:

- Code passes `npm run lint` and `npm run test`
- New features include unit tests
- Template pack changes include updated `test_data/` fixtures and passing build-checks
- Commit messages are clear and reference the motivation

See `.github/workflows/ci.yml` for the full CI pipeline.

## Release

Every merge to `main` auto-publishes to npm:

1. CI runs the full test matrix (build, lint, test, template pack build-checks)
2. On success, a bot bumps the patch version of every publishable workspace
3. Tags are pushed and packages are published to the public npm registry

See `.github/workflows/ci.yml` for details.

## License

MIT — see [LICENSE](LICENSE) for details.

## Authors

Crafted by [Mohan TN](https://github.com/MohanTn) and [contributors](https://github.com/MohanTn/scaffold-toolkit/graphs/contributors).
