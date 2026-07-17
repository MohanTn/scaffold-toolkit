# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0]

### Added

- **`scaffold add` command family** — the entity-first enterprise surface: `add feature` (CRUD with `--operations` subsetting, `--db`, `--combine`, `--namespace`), `add custom` (custom query/command endpoints layered onto an existing controller + repository via marker injection), and `add domain-event` / `factory` / `helper` / `cloud-provider` / `scheduler-job` / `health-check` / `outbox-processor`. Each subcommand is a pure compiler from flags to an artifact-scoped intent manifest, run through the exact same deterministic generate pipeline (`manifest new` + `generate` stay fully supported as the low-level layer).
- **Artifact scoping**: optional `artifact` tag on descriptor targets/injections plus optional `artifacts` on the intent manifest (and `--artifact` on `manifest new`). A manifest without `artifacts` renders everything — byte-identical to before; with it, only the listed tags (untagged entries are `base`) render. `validate-pack` applies the same selection.
- **`when` conditionals** on descriptor targets/injections: dot-path equality against the render context (expected `false` also matches unset), powering config-level layout swaps like the combined repository file.
- **Per-pack `defaults`** in `.scaffold/config.json`: free-form manifest defaults merged under every manifest for that slot (explicit manifest keys win, `options` merges one level deep) — repo-wide settings like `options.combine` without repeating flags.
- **`hashTrailerSuffix`** on descriptor injections, so wrap-style comment syntaxes (XML `<!-- -->` in `.csproj`) get a closed, valid trailer line.
- **Descriptor `pathConfig`** promoted to a typed field: the pack's own default layout now resolves `{{pathConfig.*}}` in generate AND in `check-edit` ownership matching (multi-segment fragments like `Api/Controllers` match literally instead of one wildcard segment) when neither the config slot nor the manifest overrides it.
- **`v9-enterprise` template pack** (`packages/templates-dotnet/v9-enterprise`): single-project ASP.NET Core 8 with layer folders, built for `scaffold add`. Implicit `Guid Id` on entities; combined interface+implementation repository layout behind `options.combine`; custom endpoints wired as frozen injections (`CONTROLLER_ACTIONS`, `REPO_INTERFACE_METHODS`) plus a create-mode partial-class file carrying the editable AI seam; domain events, factories, Guard/Crypto helpers, real-SDK cloud storage providers (AWS/Azure/GCP) with csproj `INFRA_PACKAGES` injection, BackgroundService scheduler jobs, health checks, and an outbox processor. Own fixtures (`test_data/v9/`), build-check (`tools/validate-build-v9.mjs` — drives the real `add` commands, then `dotnet build`/`test`), and guardrails check (`tools/check-guardrails-v9.mjs`), all gating publish in CI.
- Restored the Claude Code hook test suite at `test/hooks/` (ported from the deleted adapter package) and extended it for the new pack resolution logic.

### Removed

- **Legacy template packs**: `packages/templates-dotnet/v8-controller`, `v8-controller-gcp`, `v8-controller-storemedia-v2`, and `packages/templates-node`, plus their fixtures, examples, build-check/guardrails scripts, and CI jobs — superseded by `v9-enterprise` (the `cloud-provider` artifact replaces the GCP layer). All recoverable from git history and the standalone template repos. The engine's built-in `ANCHOR_CATALOG` fallback for those pack versions stays: it is engine behavior for externally-hosted legacy packs, not repo content.

### Changed

- **Repo flattened to a single npm package** (`@mohantn/scaffold-core` at the root): `packages/core` → `src/`, the Claude Code adapter → `hooks/` (now published with the package; hooks prefer the sibling `dist/cli.js` and fall back to PATH). CI rewritten for the single-package layout. The GitHub Copilot CLI adapter is dropped for now — it can return later as a thin wrapper over the same `check-edit`/`status`/`next` CLI contract.
- `loadDescriptor` checks `requires.scaffoldCli` BEFORE schema validation, so an old CLI reading a newer pack reports a version mismatch instead of a schema-error wall.
- `runGenerate` accepts an in-memory manifest (exactly one of `manifestPath`/`manifest`), the path the `add` compilers use.
- The generate report echoes `artifacts` and per-filter skipped-entry counts when a run is scoped.

### Fixed

- `hooks/packManifestReader.mjs` pack resolution rewritten for the real config schema (per-slot `adoptedPaths` as exact repo-relative paths, path-based packs read straight off disk, url packs via the `.scaffold/cache` layout) — the coding-standards injection path was previously inert.

## [0.2.x]

### Changed

- Expanded codingStandards section from 5 generic handler rules to 20+ detailed specifications covering the full clean architecture/DDD+CQRS stack. Each file type now has prescriptive guidance on immutability, validation, dependency injection, error handling, and architectural layering.
- README.md expanded from minimal technical description to comprehensive project documentation with badges, quick-start instructions, clear value propositions, restructured package descriptions as a table, explicit contribution guidelines, and improved release notes. Maintains all existing technical content while significantly improving user onboarding and project presentation.

### Added

- Introduces `@mohantn/scaffold-adapter-copilot-cli` with preToolUse, postToolUse, agentStop, and sessionStart hooks that enforce deterministic scaffolding (blocking pack-owned file writes, requiring AI_IMPLEMENTATION block fills). Refactors shared logic in Claude Code adapter into `packManifestReader.mjs` and adds symlink-safe entry point detection via `isMainModule.mjs`. Supports configurable enforcement modes (gate/nudge) via `.scaffold/conf.json`. Comprehensive test suites added for both adapters.
- This change implements two approved MVP features: `scaffold next` provides a compact work digest for agents to fill AI_IMPLEMENTATION blocks without re-reading generated files, and `scaffold pack new` scaffolds minimal template pack skeletons. The core status scanning logic is refactored into a shared module for both commands. Bootstrap markers are enhanced to detect files pending generation and narrow multiple candidate files. The unmaintained tools/benchmark directory is completely removed. .NET templates gain exception handling and database bootstrap support with improved brownfield wiring via Directory.Build.targets.
- Added `.summary()` and `.addHelpText()` to all CLI commands with examples, enabled error help suggestions, and added tests for the improved help system. Users can now run `scaffold <command> --help` to see practical usage examples, and errors suggest looking at help for more info.
- Adds brownfield adoption support to scaffold-toolkit: `scaffold bootstrap-markers` now maps descriptor entries to existing files, persists confident matches to config, and `check-edit` gates adopted files identically to generated ones. Supports directory-layout mismatch via persisted `pathConfig`/`companyProjectName` resolution.
- Adds `scaffold manifest new` CLI command to build intent manifests from compact specs, introduces Node.js/TypeScript template pack proving stack-agnostic engine, adds GCP cloud variant for .NET, enhances template validation, and documents enforcement layers via hooks.
- Adds a manifest creation gate that rejects `scaffold generate` if any `overwrite`-mode target doesn't already exist on disk, preventing data loss. Gate runs before rendering and dry-run short-circuit, validating the manifest early. Includes unit tests, integration tests validating Windows path normalization, multiple violations batched into one error, and regression tests for existing modes.
- Switch scaffold-toolkit from git-URL-based template pack consumption to local-directory packs. `scaffold init --pack` now only accepts local paths (rejecting git URLs with clear errors), writes `path`-based config entries, and all downstream commands (`generate`, `sync`, `list`, `bootstrap-markers`, `validate-pack`) handle the no-clone, no-cache workflow. Git-URL engine remains as fallback for future non-vendored packs but is no longer used by the CLI.
- Implements descriptor v2 additive features (inputs, commentSyntax, bootstrapAnchors) that allow packs to define their own contracts and marker placement rules. Relaxes the base manifest schema to only require manifestSchemaVersion and targetStack, with per-pack input validation (including prototype-pollution defenses) enforced after descriptor load. Existing dotnet packs remain byte-for-byte compatible.
- **Pack-driven scaffolding (descriptor v2 additive)**: three new optional descriptor fields let a pack declare its own input vocabulary, comment syntax, and brownfield anchors, so the CLI engine drives any language or architecture without engine code changes:
  - `inputs`: per-pack contract for the intent manifest (e.g. `aggregate` + `events[]` for an event-sourced backend; `entity` + `fields[]` is the legacy default and stays the contract for any descriptor without an `inputs` declaration). Enforced after the descriptor loads by a new `validateManifestInputs` step in `manifest/inputValidation.ts`, with `Object.create(null)` + `Object.defineProperty` defending against prototype-pollution-style hostile pack declarations.
  - `commentSyntax`: pack-level extension-to-comment-syntax map, with `{prefix}` or `{wrap: [open, close]}` shapes. Resolved by `generate/commentSyntax.ts`'s `resolveMarkerSyntax` with precedence **per-injection override → pack map → built-in TABLE → hard error**, mirroring the built-in rules. Threads through `generate/injector.ts` via a new `InjectionRequest.packSyntaxMap` and through `validatePack`'s host-file synthesizer.
  - `bootstrapAnchors`: brownfield anchor declarations per pack. A new `compileBootstrapAnchors` converts raw string patterns to RegExp anchor groups, runs the reserved-namespace guard on every marker, and falls back to the built-in `ANCHOR_CATALOG` whenever the descriptor omits the field — preserving byte-for-byte compatibility with every existing dotnet pack. `bootstrap-markers` now loads the relevant descriptor from cache (or from a local `--pack <dir>` override) and emits non-fatal load failures to a new `warnings` channel so the command stays useful when the cached descriptor is broken. Adds a `--pack <dir>` option to `scaffold bootstrap-markers` for pack authors testing against an un-synced local descriptor.
- **Relaxed base manifest schema**: `entity`/`fields` are no longer universally required at the base-schema layer. Only `manifestSchemaVersion` + `targetStack` are, with their shape still validated when present. Per-pack enforcement of the declared input contract (or the legacy default) happens after the pack descriptor loads.

### Fixed

- The `bootstrap-markers` fallback chain (descriptor-declared → built-in `ANCHOR_CATALOG` → `unsupportedPacks`) now gracefully handles a descriptor that exists but fails to load (e.g. `requires.scaffoldCli` mismatch): the failure is recorded on a `warnings` channel and the command falls through to the built-in catalog, so a pack with an out-of-sync CLI version today doesn't silently regress a path that previously worked.

### Security

- `manifest/inputValidation.ts`'s ajv schema-fragment construction defends against a hostile pack declaring `{ name: "__proto__" }` (or other prototype-namespaced keys) in its `inputs[]`: `properties` is built via `Object.create(null)` plus `Object.defineProperty` for own-property semantics, so the fragment cannot pollute `Object.prototype`. A regression test asserts `Object.prototype` integrity after running the compile-validate cycle with hostile input.

- Implements pack-local Handlebars helper registration so template packs can ship a `helpers.js` that defines custom helpers for use in their templates. Refactors built-in helper registration from lazy (on first compile) to eager (at module load), ensuring pack helpers always override built-ins of the same name.

## [0.2.0]

### Added

- Adds six case conversion helpers (camelCase, PascalCase, snake_case, kebab-case, upper, lower) to Handlebars with multiple aliases for template convenience, includes project documentation, and updates dependencies.
- Adds an optional `strategy` (`replace | append`) to descriptor `injections[]` entries. `append` gives per-entity markers (DbSets, DI registrations, routes, barrel exports) accumulate semantics: each distinct snippet is appended once, re-runs are idempotent no-ops, and the hash trailer covers the accumulated block. Default stays `replace`.
- Adds **required AI blocks**: a start marker tagged `:required` (`SCAFFOLD:AI_IMPLEMENTATION:START:required` / `AI_IMPLEMENTATION_START:required`) is tracked by `scaffold status` — and blocked on by the adapter `Stop`/`agentStop` hooks — until its content changes from the shipped placeholder, even when that placeholder already compiles. This arms the deterministic loop for the base packs, whose business-logic seams ship working defaults rather than empty stubs. Untagged blocks stay optional (tracked only when empty). The pending record now keys blocks by their ordinal in the file, so tracking survives line drift as earlier blocks are filled.
- Adds `scaffold validate-pack --pack <dir> --manifest <file>` — a pack-author / CI smoke test that runs a real generate (injection included) against a synthesized target repo, catching template, marker-syntax, comment-syntax, and descriptor-`requires` errors that render-only validation misses.

### Fixed

- The Handlebars render context now passes every top-level intent-manifest field through to templates (e.g. the react packs' host-precomputed `entityCamel`, `entityPlural`, `primaryKeyField`), not just `entity`/`fields`/`options`.
- `AI_IMPLEMENTATION` block scanning now also matches the colon form `SCAFFOLD:AI_IMPLEMENTATION:START/END` used by the dotnet packs, so their fill-in blocks appear in the generate report.
