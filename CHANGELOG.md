# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
