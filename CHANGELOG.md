# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- README.md expanded from minimal technical description to comprehensive project documentation with badges, quick-start instructions, clear value propositions, restructured package descriptions as a table, explicit contribution guidelines, and improved release notes. Maintains all existing technical content while significantly improving user onboarding and project presentation.

### Added

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
