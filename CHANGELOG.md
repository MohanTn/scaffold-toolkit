# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Adds six case conversion helpers (camelCase, PascalCase, snake_case, kebab-case, upper, lower) to Handlebars with multiple aliases for template convenience, includes project documentation, and updates dependencies.
- Adds an optional `strategy` (`replace | append`) to descriptor `injections[]` entries. `append` gives per-entity markers (DbSets, DI registrations, routes, barrel exports) accumulate semantics: each distinct snippet is appended once, re-runs are idempotent no-ops, and the hash trailer covers the accumulated block. Default stays `replace`.

### Fixed

- The Handlebars render context now passes every top-level intent-manifest field through to templates (e.g. the react packs' host-precomputed `entityCamel`, `entityPlural`, `primaryKeyField`), not just `entity`/`fields`/`options`.
- `AI_IMPLEMENTATION` block scanning now also matches the colon form `SCAFFOLD:AI_IMPLEMENTATION:START/END` used by the dotnet packs, so their fill-in blocks appear in the generate report.
