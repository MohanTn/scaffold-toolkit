# Portable AI-Assisted Scaffolding CLI

## Context

Today, using Copilot or Claude Code to scaffold a new backend endpoint plus its matching frontend client means the LLM re-types the same boilerplate (DTOs, service interfaces, DI wiring, controller routing, TypeScript types) on every request, at full LLM latency, with no guarantee the backend DTO and frontend type stay in sync. This plan splits that work into a deterministic half (file and boilerplate generation, which never needs an LLM) and a probabilistic half (the join logic, mapping, and business rules, which does), and packages the deterministic half as a single portable engine that any coding agent (Claude Code CLI today, GitHub Copilot CLI as well) can drive, for any target stack, without the engine's own code changing when the target framework changes version (for example .NET 8 controllers migrating to .NET 10 minimal APIs, or React moving from Axios to TanStack Query).

The original design was pressure-tested twice: once by the user before this session, and again by a Plan agent during this session against this repository's actual established conventions (verified directly against `pipeline_worker`, the reference implementation named in the user's global CLAUDE.md). That second pass surfaced one real conflict (the original draft said "GitHub Packages," but the established convention, and a hard requirement of this tool's own design, is the public npm registry) and one real design gap (the config file's pack model didn't actually fit the two-independent-template-repos architecture). Both are resolved below.

Two artifacts travel through a host LLM's context window: the intent manifest the host writes, and the report the CLI hands back. Both are encoded in TOON (`@toon-format/toon`) rather than plain JSON. This was verified during this session, not assumed: the package is real, live on the npm registry at v2.3.0, MIT licensed, actively maintained (last release May 2026, last push June 2026, ~24,800 GitHub stars), and exports exactly `encode(data, options?)` / `decode(toonText, options?)` with a documented deterministic lossless round-trip for arbitrary JSON. Token savings are largest on uniform/tabular arrays of objects and smaller on deeply nested data — an efficiency caveat, not a correctness one. Since the whole point of this tool is cutting LLM time and cost out of boilerplate work, using the same JSON data-model contract but a cheaper wire format at the two LLM-facing boundaries is a direct extension of that goal, not a separate feature. `pipeline_worker` already depends on this same package, so it is a proven quantity in this environment.

## Architecture overview

Three layers:

1. **Interface layer** (thin, zero business logic): a Claude Code Skill, and a `gh` CLI extension for GitHub Copilot CLI. Both do the same two things: turn a natural-language request into a JSON intent manifest using their own host LLM, then shell out to the core CLI.
2. **Portable core**: one npm-published TypeScript CLI (`scaffold`). It never calls an LLM. It validates the manifest, resolves a versioned template pack, renders files, injects registration snippets into existing files via paired text markers, and prints a JSON/TOON report.
3. **Template & engine layer**: template packs live in their own git repositories (not npm packages), one folder per target-stack version, each folder holding Handlebars templates plus a small descriptor file that tells the generic engine what to do. Upgrading a framework version means adding a new folder, never touching engine code.

The key property that makes this portable across hosts: **the core CLI is LLM-agnostic**. Phase 1 (manifest authoring) and Phase 3 (filling in `AI_IMPLEMENTATION` blocks) are both done by whichever host agent invoked the CLI, using that host's own LLM and its own file-editing tool. The CLI's only contract with the host is the manifest going in and the report coming out.

## Repository layout

An npm workspaces monorepo, `scaffold-toolkit/`:

```
scaffold-toolkit/
  packages/
    core/                    # published as @mohantn/scaffold-core, the bin CLI
    adapter-claude-code/     # the Claude Code Skill (markdown, no code, private: true)
    adapter-copilot-cli/     # the gh CLI extension shim
  .github/workflows/ci.yml
  package.json               # workspaces root
```

Template packs are separate repositories, not part of this monorepo:

```
scaffold-templates-dotnet/
  v8-controller/{manifest.templates.json, Service.cs.hbs, Controller.cs.hbs, di-registration.hbs}
  v10-minimal-api/{manifest.templates.json, Endpoint.cs.hbs, di-registration.hbs}

scaffold-templates-react/
  axios-ts/{manifest.templates.json, apiClient.ts.hbs, types.ts.hbs}
  tanstack-query/{...}
```

## Established conventions this project follows (verified against `pipeline_worker`)

- **CI/CD**: Node 22/24 matrix; `actions/checkout@v4` + `actions/setup-node@v4` (`cache: npm`); test job runs `npm ci && npm run build && npm run lint && npm test` (build before test, since tests exercise compiled `dist/`); publish job gated on `push` to `main` + `needs: test`, `concurrency: { group: publish, cancel-in-progress: false }`, `permissions: { contents: write, id-token: write }` for OIDC npm provenance; version bump is `npm version patch`, tag pushed with `--follow-tags`; publish uses `NODE_AUTH_TOKEN: secrets.NPM_TOKEN` against **the public npm registry**, not GitHub Packages.
  - **Resolved conflict**: the original draft said "GitHub Packages registry." That's wrong for two independent reasons: it contradicts this author's own established, already-shipping convention, and it would require every consumer — including Claude Code and `gh-scaffold` users running `npx @mohantn/scaffold-core` — to authenticate to a scoped registry just to install the tool, directly undermining the "any host agent can `npx` this" design goal. Using public npm.
- **CLI version flag**: ESM file, `path.dirname(fileURLToPath(import.meta.url))` for `__dirname`, `readFileSync` of `package.json` relative to the compiled `dist/cli.js` (one directory up), wired via commander's `program.version(pkg.version, '-v, --version', '...')`.
- **package.json conventions**: `"type": "module"` (full ESM, `.js` extensions in TS imports), `"files": ["dist", "README.md", "LICENSE"]`, `"engines": {"node": ">=20.12"}`, scripts `build` (`tsc -p tsconfig.json`), `lint` (`eslint . --ext .ts`), `test` (`node --import tsx --test test/**/*.test.ts`), `prepublishOnly` (not `prepare`) running the build.
- **tsconfig**: ES2022 target, NodeNext module/resolution, strict true, declaration + sourceMap, `resolveJsonModule`.
- **Test framework**: Node's built-in `node:test` + `node:assert/strict` via `tsx`, no mocking libraries — integration tests exercise real fixtures (real throwaway git repos via `mkdtempSync` + `git init`), matching this project's stated preference for testing real behavior over mocks.
- **Dependency discipline**: hand-roll small wrappers instead of adding a dependency for something a `execFile('git', [...])` call covers (`pipeline_worker`'s own `src/git/*.ts` does this — no `simple-git` dependency). Applied here: template pack cloning uses a hand-rolled git wrapper, not a git library.
- **Confirmed via repo-wide search**: nothing in this monorepo already implements Handlebars rendering, marker/injection-comment logic, or ajv/JSON-Schema validation. This is a clean build. The only other npm-workspaces-root precedent is `ytube-mp3/package.json` (`"workspaces": ["client"]`), a minimal reference only.

## Core CLI (`packages/core`)

Commands:

- **`scaffold init [--project-type <type>]`** — writes `.scaffold/config.json`. When `--project-type` is omitted, `projectTypeDetect.ts` sniffs the target repo (`*.csproj`/`*.sln` → dotnet, `package.json` dependencies like `react`/`next` → js-family, `go.mod` → go, `pyproject.toml`/`requirements.txt` → python) and falls back to a single interactive stdin prompt only on ambiguity. This interactive fallback is unique to `init` — `generate` and `undo` stay fully non-interactive since host agents invoke them unattended.
- **`scaffold templates sync [--update]`** — clones or pulls the configured template pack(s) into a local cache keyed by `sha256(normalizedPackUrl)/<resolvedSha>`, not by version-folder name alone (this closes a real collision: two different pack URLs could otherwise have a same-named version folder and clobber each other's cache). `--update` re-resolves the ref to the latest remote SHA and rewrites the pinned SHA in `.scaffold/config.json`; without it there is no supported path to deliberately move a pinned pack forward, which was a genuine gap.
- **`scaffold templates list`** — lists available version folders for the configured pack.
- **`scaffold generate --manifest <file.toon|.json> [--dry-run] [--force] [--json]`**:
  1. Decode the manifest (TOON by extension via `@toon-format/toon`, or plain `.json` for non-LLM tooling/CI fixtures) and validate against the intent manifest's JSON Schema (ajv), regardless of wire format.
  2. Validate the resolved template pack's `manifest.templates.json` descriptor against its own schema, and check its `requires.scaffoldCli` semver range against the installed CLI version, failing fast on mismatch before any file is touched.
  3. Resolve every output path and confirm it stays inside the target repo root; reject any path that would escape it.
  4. Render `create`-mode targets from Handlebars (skip or error per `mode: create | skip-if-exists | overwrite`).
  5. For each injection target, locate its marker pair by ID. Missing, duplicated, or one-sided → hard error including file path and line number. Content matches the stored per-marker hash trailer → skip (idempotent). Content differs → refuse unless `--force`, always showing a diff in the report.
  6. Write `.scaffold/changes/<timestamp>.json`, recording both the prior content and a hash of the exact content just written, for every file touched.
  7. Print a report: files created, files injected, and for every `AI_IMPLEMENTATION_START/END` block its file, start/end line, current content, and whether it's empty (so a host agent never blindly re-fills an already-completed block). TOON by default; `--json` for plain JSON.
  - `--dry-run` is not a separate code path: `generate.ts` is a single orchestrator taking `{dryRun: boolean}`, and every step through rendering and injection-point diffing runs identically regardless of the flag — only the final disk-write and change-manifest steps are gated on `!dryRun`. This is what guarantees dry-run output matches the real run, provided the working tree is unchanged in between (the tool does not lock or snapshot the repo across separate invocations).
- **`scaffold undo <changeset-id>`** — reverts a prior `generate` run. Before touching a file, compares its current on-disk hash against the post-generate hash stored in the change-manifest; if they differ (meaning something else edited the file since), it refuses and prints a diff unless `--force`. This closes a real gap the original draft didn't address: blind restoration could otherwise silently discard a developer's manual edit made after generation. Two further semantics, also gaps in the original draft:
  - **Created files are deleted, not just "reverted."** If the change-manifest records a file as created (no prior content), undo — after the hash check above passes — deletes the file rather than leaving it with stale content, since "restore prior state" for a created file means it shouldn't exist.
  - **Undo is strictly reverse-chronological per file.** Before reverting, the CLI checks whether any *later* changeset also touched the same file(s) as the one being undone (e.g. changeset A creates `X.cs`, changeset B later injects into it). If so, it refuses and names the later changeset id(s) that must be undone first, rather than silently deleting or corrupting a file that a subsequent run also depends on.
- **`scaffold bootstrap-markers [--pack-version <version>] [--dry-run] [--json]`** — bootstraps empty `SCAFFOLD:<marker>:START/END` marker pairs into a brownfield repo's existing source files, keyed by the exact configured template-pack version rather than the coarse `projectType` bucket, so a plain `scaffold generate` (unmodified) can later find and fill them by marker ID. Without `--pack-version`, it requires `.scaffold/config.json` and runs one pass per entry in `packs`, tagging every report entry with that entry's slot name; `--pack-version` runs exactly one pass against the given version directly, no config file required, tagged `(--pack-version override)`. See "Marker bootstrapping for brownfield repos" below for the anchor catalog and placement rules. Exits non-zero while any marker is left `needs-manual`.
- **`scaffold -v` / `--version`** — reads the installed version from `package.json` at runtime relative to the compiled entry file, per this project's standing convention.

Per-file provenance: `.scaffold/config.json` records, per injected file, which pack **identity** last touched it — not just the version-folder name. Provenance is stored as `{ packUrl: <normalized git URL>, packVersion: <folder name>, resolvedSha: <commit SHA> }`, not `packVersion` alone. This closes a real ambiguity: if a pack's URL is repointed to a different repository that happens to also contain a `v10-minimal-api` folder, or the pinned SHA moves via `--update`, folder-name-only provenance would wrongly treat that as "the same template" and inject blindly. With the full identity recorded, any of those changes makes the recorded provenance not match, and the CLI refuses ("this file was scaffolded under v8-controller; migrating to v10-minimal-api requires a manual marker migration") rather than guessing. A `--migrate` auto-rewrite flag was considered and rejected: no two real pack versions yet demonstrate a common enough migration shape to justify a generic migration engine; revisit only if one does.

### `.scaffold/config.json` shape (corrected from the original draft)

The original draft modeled `templatePack`/`templateVersion`/`frontendTemplate` as loose top-level fields, but the architecture's own repo layout has backend and frontend template packs as two fully independent git repos — that mismatch would have blocked implementation. Corrected shape:

```json
{
  "projectType": "dotnet+react",
  "packs": {
    "backend":  { "url": "https://github.com/org/scaffold-templates-dotnet.git", "version": "v10-minimal-api", "pinnedSha": "abc123..." },
    "frontend": { "url": "https://github.com/org/scaffold-templates-react.git", "version": "tanstack-query", "pinnedSha": "def456..." }
  }
}
```

The intent manifest carries a `targetStack` field (a key into `packs`, e.g. `"backend"`), so `generate` knows which pack a given manifest invocation targets, and which pack's provenance record and `requires` check apply.

### `manifest.templates.json` descriptor (v2, hand-authored once per pack — stays plain JSON, no LLM touches it, so no TOON benefit)

```json
{
  "descriptorSchemaVersion": 2,
  "packVersion": "v10-minimal-api",
  "requires": { "scaffoldCli": ">=1.0.0 <2.0.0" },
  "targets": [
    { "output": "src/Endpoints/{{entity}}Endpoint.cs", "template": "Endpoint.cs.hbs", "mode": "create" }
  ],
  "injections": [
    { "file": "Program.cs", "marker": "SCAFFOLD_DI", "template": "di-registration.hbs", "position": "before-end", "hashTrailerPrefix": "// scaffold-hash:" },
    { "file": "Program.cs", "marker": "SCAFFOLD_ROUTES", "template": "route-registration.hbs", "position": "before-end", "hashTrailerPrefix": "// scaffold-hash:" }
  ]
}
```

Two entries deliberately target the same file (`Program.cs`) with independent markers and hash trailers — this is the fixture that proves the hash trailer is scoped per marker block, not per file. That was already true in the array-of-entries shape but underspecified in the original draft; it is now explicit and covered by an integration test fixture.

`marker` is a stable logical ID, not raw comment syntax, so the same descriptor works whether the target file uses `//`, `#`, or `<!-- -->` comments; the injector renders the actual marker text per file type. The schema rejects any `marker` value starting with `AI_IMPLEMENTATION` (`not: {pattern: "^AI_IMPLEMENTATION"}`), reserving that namespace so a pack author can never accidentally collide a real injection marker with the phase-3 fill-in region.

ajv schema notes: the root descriptor object allows unknown top-level fields (`additionalProperties: true`), so a newer pack using a CLI-version field this engine doesn't yet know about doesn't hard-fail; each `targets[]`/`injections[]` entry keeps `additionalProperties: false` with its own `required` list, so typos in known fields are still caught. `requires.scaffoldCli` is checked with the `semver` package against the installed CLI's own version at descriptor-load time (shape-checked by ajv, range-checked separately).

### Intent manifest schema (the phase-1 artifact, minimal and stack-agnostic)

```json
{
  "manifestSchemaVersion": 1,
  "targetStack": "backend",
  "entity": "Invoice",
  "fields": [
    { "name": "id", "type": "guid" },
    { "name": "amount", "type": "decimal" }
  ],
  "options": { "route": "/api/invoices" }
}
```

Required: `manifestSchemaVersion`, `targetStack` (string), `entity` (string, PascalCase pattern), `fields` (array, `minItems: 1`, each requiring `name`/`type`). `options` stays `additionalProperties: true` and free-form, passed through as-is into the Handlebars render context — deliberately loose, since semantic field validation belongs to each pack's own templates, not a stack-aware schema layer in the CLI.

## Injection engine (`packages/core/src/generate/injector.ts`)

The highest-risk file in the system, since it edits a developer's existing source, so its behavior is fully enumerated:

- Exactly one occurrence of a marker start/end pair expected per file per marker ID; zero, one-sided, or duplicate occurrences are hard errors that include the file path and line number (a byproduct of the line-by-line scan already required to find the markers, not new work).
- Idempotent by per-marker content hash: identical requested content plus existing hash trailer means skip; different content means refuse-and-report unless `--force`.
- Injected regions and phase-3 `AI_IMPLEMENTATION` fill-in regions never overlap: the injector only ever reads the `AI_IMPLEMENTATION` marker family (to build the report) and never writes into it, and the reserved-namespace schema rule above prevents a pack from ever declaring a real injection there.
- **Multi-marker-per-file injection is a single-pass rebuild, not sequential patches.** The `Program.cs` fixture above has two independent markers in one file; naively injecting at the first marker's line offsets and then re-using line numbers collected before any write would misplace the second injection once the first shifts the file. `markerScan.ts` scans the *original* file content once, recording every marker pair's byte offsets in that unmodified content; `injector.ts` then builds the entire new file content in one string-replacement pass over those original offsets (working outward from a single source string, never re-reading the file mid-injection). This makes injection order irrelevant by construction rather than relying on a convention like "process in descending line order."

### Marker comment syntax

The injector needs the actual comment syntax per target file to render a logical `marker` ID (e.g. `SCAFFOLD_DI`) into real start/end tags and a hash trailer. `generate/commentSyntax.ts` holds a small extension-to-syntax table:

| Extensions | Start/end wrapper | Hash trailer |
|---|---|---|
| `.cs`, `.ts`, `.tsx`, `.js`, `.jsx`, `.java`, `.go`, `.rs` | `// SCAFFOLD:<marker>:START` / `:END` | `// scaffold-hash:<hex>` |
| `.py`, `.rb`, `.sh`, `.yml`, `.yaml` | `# SCAFFOLD:<marker>:START` / `:END` | `# scaffold-hash:<hex>` |
| `.html`, `.xml`, `.vue` | `<!-- SCAFFOLD:<marker>:START -->` / `:END -->` | `<!-- scaffold-hash:<hex> -->` |

An injection entry in `manifest.templates.json` may override this with an explicit `commentSyntax: { start: "...", end: "..." }` for edge cases the table doesn't cover (e.g. a `.cs` file with embedded Razor markup) — the table handles the common case, override is the escape hatch. A target file whose extension has no table entry and no override is a hard error naming the file and suggesting an explicit `commentSyntax` override, rather than guessing at a syntax that could corrupt the file.

## Marker bootstrapping for brownfield repos (`packages/core/src/bootstrapMarkers`)

`scaffold bootstrap-markers` solves a distinct problem from `generate`: a brownfield repo that already has real `Program.cs`/`AppDbContext.cs`/`ApplicationServiceCollectionExtensions.cs` files, written before this tool was adopted, has nowhere for the injector to find a `SCAFFOLD:<marker>:START/END` pair. This feature inserts *empty* marker pairs at the right spot so the untouched injector (`injector.ts`, `markerScan.ts`) can then find and fill them exactly as it would in a repo scaffolded from scratch — it never writes marker content itself, only the empty START/END shell.

`bootstrapMarkers/anchorCatalog.ts` hand-encodes where each marker belongs, keyed by the **exact** pack version (not the coarse `projectType` bucket used elsewhere), because the marker set and `Program.cs` zones differ between a base pack and its GCP sibling. This mirrors `scaffold-templates-dotnet`'s own README marker table (kept in sync by hand; the two documents should never drift):

| Marker | File | `v8-controller` | `v10-minimal-api` | `v8-controller-gcp` | `v10-minimal-api-gcp` |
|---|---|---|---|---|---|
| `GSM` | `Program.cs` (builder zone) | — | — | ✓ | ✓ |
| `DI` | `Program.cs` (builder zone) | ✓ | ✓ | ✓ | ✓ |
| `PUBSUB` | `Program.cs` (builder zone) | — | — | ✓ | ✓ |
| `SAGAS` | `Program.cs` (builder zone) | — | — | ✓ | ✓ |
| `MIDDLEWARE` | `Program.cs` (app zone) | — | ✓ | — | ✓ |
| `ROUTES` | `Program.cs` (app zone) | — | ✓ | — | ✓ |
| `DBSETS` | `AppDbContext.cs` | ✓ | ✓ | ✓ | ✓ |
| `REPOSITORIES` | `ApplicationServiceCollectionExtensions.cs` | ✓ | ✓ | ✓ | ✓ |

Two anchor kinds, both single-occurrence and never-guess:

- **`after-line`** (the builder zone, anchored on `.CreateBuilder(`; the app zone, anchored on `.Build();`): a single-occurrence regex line search. Zero or multiple matches falls every marker in the group back to `needs-manual`.
- **`after-class-brace`** (`DBSETS` on `AppDbContext`'s class declaration, `REPOSITORIES` on `AddApplication(this IServiceCollection services)`'s signature): no universal single-line anchor exists in either file, so this finds the single-occurrence declaration line, then scans forward a bounded few lines for the first opening brace and takes it as the class body's start. Zero or multiple declaration matches, or no brace found within the lookahead, falls back to `needs-manual` the same way.

Within one zone, markers are always placed as a single contiguous block, in `ANCHOR_CATALOG`'s declared order, immediately after the anchor: `GSM` precedes `DI` precedes `PUBSUB` precedes `SAGAS` in the builder zone, because `InfrastructureServiceCollectionExtensions.cs`'s `AddInfrastructure` reads a connection-string config key at registration time that `GSM` populates — placing `DI` first would register infrastructure before its configuration exists. `MIDDLEWARE` precedes `ROUTES` in the app zone to match ASP.NET Core's request-pipeline registration order.

Idempotent, one-time, never-overwrite: each marker's existing occurrence is checked independently (a tolerant trimmed-line count of its START/END text, the same technique `markerScan.ts` uses but re-implemented locally rather than imported, since this module intentionally never touches `markerScan.ts`). Present exactly once on both sides → `already-present`, left untouched wherever it is in the file (a developer may have hand-moved it). Present on only one side, or duplicated → `needs-manual` with a `markerScan.ts`-style `file:line` reason. Absent on both sides → queued for placement. A repeat run of an already-bootstrapped file is therefore byte-identical.

Git safety net: inside a git working tree, a candidate file must be tracked and have an empty `git status --porcelain` before it is touched; a dirty or untracked file is reported `needs-manual` with a git-state reason instead of being silently skipped or, worse, written over uncommitted work. Outside a git working tree (the target repo is a plain directory) this check is skipped entirely — `scaffold` never requires the target to be a git repo. `isInsideGitWorkTree` distinguishes git's own clean "not a git repository" signal from any other execution failure (a missing `git` binary, a permissions error): only the former is treated as "no repo here, skip the check"; anything else throws, so the command fails loud rather than silently disabling its own safety net.

A configured pack slot whose version has no `ANCHOR_CATALOG` entry at all (e.g. a `frontend` slot in a `dotnet+react` config) is reported under `BootstrapMarkersReport.unsupportedPacks`, a field kept separate from `needsManual` on purpose: there is no per-marker remediation available for a slot the catalog simply doesn't cover, so `cli.ts` gates its exit code on `needsManual.length > 0` alone — an unsupported pack slot never blocks a clean exit once every actionable marker elsewhere is placed or already-present.

## Rejected feature: pre/post-process shell hooks

A template pack descriptor field allowing arbitrary shell commands to run before or after rendering was proposed during review and is explicitly rejected, not deferred. A pack is fetched from a separately-versioned (often third-party) git repo, and `scaffold generate` is designed to run unattended on a host agent's behalf. Letting a pack maintainer's descriptor declare shell commands that execute unattended is an unattended remote-code-execution vector that directly undermines this tool's core value proposition of deterministic, safe, no-LLM-in-the-loop scaffolding. If a pack needs computed values, Handlebars helpers (pure functions, no shell/filesystem/network access) cover that need safely.

## Deferred to v1.1: marker-position caching

Caching scanned marker positions per file (invalidated by mtime) was suggested for large-repo performance. Explicitly deferred: it's a premature optimization with no benchmark yet showing scan cost is an actual bottleneck, and injector correctness matters more than scan speed for v1. Revisit only if a real large-repo case demonstrates the need.

## `packages/core/src` module breakdown

```
cli.ts                          # commander program: registers init/templates/generate/undo/-v; version-read mirrors pipeline_worker/src/cli.ts

config/schema.ts                # ajv schema + TS type for .scaffold/config.json (packs map, projectType)
config/loader.ts                # read/write .scaffold/config.json, resolve project root
config/projectTypeDetect.ts     # scaffold-init heuristics (csproj/package.json/go.mod/pyproject.toml sniffing)

manifest/schema.ts               # ajv JSON Schema + TS type for the intent manifest
manifest/decode.ts               # TOON/JSON auto-detect by extension, decode via @toon-format/toon, validate via ajv
manifest/types.ts                # shared TS types for the decoded manifest

descriptor/schema.ts             # ajv JSON Schema v2 for manifest.templates.json (requires, reserved-marker guard)
descriptor/load.ts               # read + validate a pack's descriptor; semver-check requires.scaffoldCli

templates/gitClone.ts            # hand-rolled execFile('git', [...]) wrapper, mirrors pipeline_worker/src/git/*.ts
templates/cache.ts                # cache path resolution: sha256(normalizedUrl)/resolvedSha, collision-safe by construction
templates/sync.ts                 # `scaffold templates sync [--update]`
templates/list.ts                 # `scaffold templates list`

generate/render.ts                # Handlebars compile+render for create-mode targets
generate/pathGuard.ts             # resolve+validate every output path stays inside repo root
generate/commentSyntax.ts         # extension -> {start,end,hashTrailer} comment-syntax table + per-injection override resolution
generate/markerScan.ts            # single-pass marker-pair scanner over original file content (byte offsets, file+line-number aware); used by injector.ts and the AI_IMPLEMENTATION report lookup
generate/injector.ts              # marker locate/validate/inject/hash-check engine; single-pass rebuild across all markers in a file
generate/provenance.ts            # per-file {packUrl, packVersion, resolvedSha} tracking + mismatch refusal
generate/changeManifest.ts        # writes .scaffold/changes/<timestamp>.json (prior content + post-write hash; created-vs-modified flag per file)
generate/pendingTracker.ts        # writes .scaffold/pending/<changeset-id>.json from the report's AI_IMPLEMENTATION entries
generate/report.ts                # builds the TOON/JSON report, incl. AI_IMPLEMENTATION current-content + file:line
generate/generate.ts              # orchestrates all steps; single code path, dry-run gates only the final write steps

status/status.ts                  # `scaffold status [--json]` — rescans .scaffold/pending/*.json, updates resolved state, non-zero exit while any block remains unfilled

bootstrapMarkers/anchorCatalog.ts      # per-pack-version marker placement data (after-line / after-class-brace anchors); reserved-namespace guard
bootstrapMarkers/repoWalk.ts           # hand-rolled recursive filename walker (no glob dependency), skips .git/node_modules/bin/obj/dist/build/.scaffold
bootstrapMarkers/gitSafety.ts          # hand-rolled execFile('git', [...]) wrapper (sync): tracked-and-clean check before touching a brownfield file
bootstrapMarkers/markerPlacement.ts    # resolves one AnchorGroup's insertion point in one file and splices its markers as one contiguous block
bootstrapMarkers/bootstrapMarkersReport.ts # builds the TOON/JSON report `scaffold bootstrap-markers` prints, mirrors generate/report.ts's format switch
bootstrapMarkers/bootstrapMarkers.ts   # orchestrates `scaffold bootstrap-markers`: resolves pack version(s), walks candidate files, threads per-file content across groups, writes once

undo/undo.ts                      # revert via change-manifest id; hash-compares current content against stored post-write hash; deletes created files after the hash check; refuses if a later changeset touched the same file(s)

toon/codec.ts                     # thin wrapper over @toon-format/toon encode/decode, shared by manifest decode + report + list output

version/readPkg.ts                # ESM __dirname + readFileSync(package.json) helper, shared by cli.ts -v and descriptor/load.ts
```

`packages/adapter-claude-code/hooks/post-tool-use.mjs` and `stop.mjs` — thin scripts that shell out to the installed `scaffold status --json` and translate its exit code/output into the Claude Code hook JSON protocol (nudge on `PostToolUse`, hard block on `Stop`).

`packages/adapter-copilot-cli/hooks/post-tool-use.mjs` and `agent-stop.mjs` — the same idea against Copilot CLI's own hook JSON protocol (nudge via flat `additionalContext` on `postToolUse`, hard block via `{decision, reason}` on `agentStop`); `packages/adapter-copilot-cli/src/installHooks.mjs` writes `.github/hooks/scaffold-toolkit.json` pointing at both, exposed as `gh scaffold install-hooks`.

Test layout mirrors `pipeline_worker/test/`: `packages/core/test/unit/*.test.ts`, `packages/core/test/integration/*.test.ts`, fixtures under `test/fixtures/` (excluded from `tsc`, same pattern as the reference project).

## Host adapters

Both built in v1.

### `packages/adapter-claude-code`

A Skill (`SKILL.md`), no executable code, `"private": true` in its package.json. Its instructions tell Claude to: build the intent manifest in TOON matching the published schema from the user's natural-language request, write it to a temp `.toon` file, run `npx @mohantn/scaffold-core generate --manifest <tmp-file>`, read the TOON report from stdout, then use its own Edit tool to fill every reported `AI_IMPLEMENTATION_START/END` location using the report's current-content field to avoid re-filling an already-completed block.

### `packages/adapter-copilot-cli`

A `gh` CLI extension (`gh extension create gh-scaffold`), a minimal Node shim exposing the same two touchpoints inside Copilot Chat's tool-calling surface: build the manifest, exec the installed `scaffold-core` binary as a subprocess, return its stdout, and on a second turn accept fill-in instructions the same way. Also ships `hooks/post-tool-use.mjs` and `hooks/agent-stop.mjs`, registered into a target repo via `gh scaffold install-hooks` — see "Determinism: enforcing phase-3 completion" below.

## Determinism: enforcing phase-3 completion

Without enforcement, whether a host LLM actually fills every `AI_IMPLEMENTATION` block after calling `generate` depends entirely on it following the Skill's prose — nothing stops it forgetting, especially mid-session. This is closed in two layers.

**Core CLI addition (portable, host-agnostic):** `generate.ts` writes `.scaffold/pending/<changeset-id>.json` alongside the change-manifest, listing exactly the `AI_IMPLEMENTATION` blocks the report marked non-empty-required (file, start/end line, original placeholder content). A new command, `scaffold status [--json]`, rescans every tracked pending file: if a block's current content no longer matches its recorded placeholder, it's marked resolved; the command exits non-zero while any block across any pending file remains unresolved, and 0 once none do. This is a scriptable, host-agnostic checkpoint usable by either adapter or by CI.

**Claude Code hooks (hard enforcement, using the real Hooks lifecycle, not prose):**
- A `PostToolUse` hook matching Bash calls whose command contains `scaffold generate`: immediately runs `scaffold status --json` in the same directory; if anything is pending, it feeds that back into Claude's context as a hook decision, a deterministic nudge delivered by the harness rather than something Claude has to remember on its own.
- A `Stop` hook: before Claude's turn is allowed to end, it runs `scaffold status --json`; if any block is still pending, the hook returns a blocking decision with the reason, so Claude cannot end the turn with unfilled blocks. This was chosen deliberately over a soft warning: a soft nudge just reintroduces the same non-determinism this feature exists to remove. The false-positive risk is low by construction, since the pending file is only ever created by `generate` itself, only tracks blocks the CLI just wrote, and only fires when than the file's tracked content is genuinely unresolved.

These hook scripts ship as files under `packages/adapter-claude-code/hooks/` (`post-tool-use.mjs`, `stop.mjs`, both thin wrappers that shell out to `scaffold status --json` and translate its exit code into the hook JSON protocol). `SKILL.md` instructs Claude to register both into the target repo's `.claude/settings.json` the first time the skill is used there — a one-time, deterministic setup action, not a manual step left to the user.

**Correction, added after initial implementation:** this section originally stated "GitHub Copilot CLI has no equivalent lifecycle-hook system as of this design" and described the `generate` precheck below as the best available gate. That was accurate when written, but GitHub Copilot CLI reached GA in February 2026 with a real hooks system (`.github/hooks/*.json`, schema at https://docs.github.com/en/copilot/reference/hooks-reference), including `postToolUse` and `agentStop` events — confirmed directly against that reference during a later session, not assumed. `adapter-copilot-cli` now ships `hooks/post-tool-use.mjs` (a `postToolUse` soft nudge, mirroring Claude Code's `PostToolUse` hook) and `hooks/agent-stop.mjs` (an `agentStop` hard block, mirroring Claude Code's `Stop` hook — `{ decision: "block", reason }` while any `AI_IMPLEMENTATION` block is pending), registered into a target repo via a new `gh scaffold install-hooks` command that writes `.github/hooks/scaffold-toolkit.json` with absolute paths to both scripts. This closes the gap: Copilot CLI now gets the same hard "cannot stop" guarantee Claude Code's Stop hook gives, live within an agent session.

The two hook protocols share the same idea but not the same wire shape: Copilot's `postToolUse` input is `{ toolName, toolArgs, cwd, ... }` (camelCase; `toolArgs` has been observed both as an object and as a JSON-encoded string) versus Claude's `{ tool_name, tool_input, cwd }` (snake_case), and Copilot's `postToolUse` output is a flat `{ additionalContext }` versus Claude's nested `{ hookSpecificOutput: { additionalContext } }`. `agentStop`'s `{ decision: "block" | "allow", reason }` output shape does match Claude's `Stop` hook, except Copilot documents `decision` as always present (this adapter's `agent-stop.mjs` always sets it explicitly), where Claude's Stop hook treats an omitted `decision` as an implicit allow.

The `generate` precheck described below is kept as a **second, independent layer**, not superseded by the hook: `agentStop` only fires inside a live Copilot agent session, so the precheck remains the only guard against `gh scaffold generate` being invoked directly — CI, a script, a bare terminal — outside one.

## CI/CD pipeline

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: { node: [22, 24] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: npm }
      - run: npm ci
      - run: npm run build   # before test — packages/core's tests exercise dist/cli.js
      - run: npm run lint
      - run: npm test

  publish:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: test
    runs-on: ubuntu-latest
    concurrency: { group: publish, cancel-in-progress: false }
    permissions: { contents: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: https://registry.npmjs.org, cache: npm }
      - run: npm ci
      - name: Bump version
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git pull --rebase origin main
          npm version patch --workspaces --include-workspace-root=false --no-git-tag-version
          NEW_VERSION=$(node -p "require('./packages/core/package.json').version")
          git commit -am "chore(release): v$NEW_VERSION [skip ci]"
          git tag "v$NEW_VERSION"
          git push origin HEAD:main --follow-tags
      - name: Publish to npm
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
        run: npm publish --workspaces
```

`npm publish --workspaces` automatically skips any workspace marked `"private": true"`, so `adapter-claude-code` needs no special-casing now or if a new publishable package is added later. **Flag for the implementer**: smoke-test `npm version patch --workspaces --include-workspace-root=false --no-git-tag-version` against the actual pinned npm version in a throwaway repo before relying on it in the first real release — the multi-workspace bump-in-one-shot behavior should be verified empirically, not assumed.

## package.json sketches

**Root:**
```json
{
  "name": "scaffold-toolkit",
  "private": true,
  "version": "0.0.0",
  "license": "MIT",
  "workspaces": ["packages/core", "packages/adapter-claude-code", "packages/adapter-copilot-cli"],
  "engines": { "node": ">=20.12" },
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "test": "npm run test --workspaces --if-present"
  }
}
```

**`packages/core/package.json`:**
```json
{
  "name": "@mohantn/scaffold-core",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "bin": { "scaffold": "dist/cli.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20.12" },
  "publishConfig": { "access": "public", "provenance": true },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint . --ext .ts",
    "test": "node --import tsx --test test/**/*.test.ts",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@toon-format/toon": "^2.3.0",
    "ajv": "^8.17.0",
    "commander": "^12.0.0",
    "handlebars": "^4.7.8",
    "semver": "^7.6.0"
  }
}
```

`tsconfig.json` for `packages/core` mirrors `pipeline_worker/tsconfig.json` (ES2022, NodeNext, strict, declaration + sourceMap, `resolveJsonModule`, `exclude: ["dist","node_modules","test/fixtures"]`). No `simple-git` dependency, per this author's stated convention against adding a dependency for something a `child_process.execFile` wrapper covers.

## Testing strategy

- **Unit**: TOON round-trip (manifest and report: encode, decode, assert deep-equal to the original object), manifest schema validation (valid and invalid), template descriptor schema validation including the `requires` semver check and the reserved-marker-namespace rule, path-traversal rejection, Handlebars rendering correctness, marker injector idempotency on a clean file.
- **Unit, hostile-input**: injector behavior against a file with a missing marker, a duplicated marker, and a one-sided marker, each asserted to error (with file path and line number in the message) rather than write.
- **Integration**: a fixture target repo plus a fixture template pack, run `scaffold generate` end to end, assert exact resulting file contents and report shape, including the two-independent-markers-in-one-file fixture (`Program.cs` with `SCAFFOLD_DI` and `SCAFFOLD_ROUTES`) proving per-marker hash trailer scoping and order-independent single-pass injection.
- **Integration, idempotency**: run `scaffold generate` twice against the same fixture target and assert byte-identical output.
- **Integration, undo**: run `generate`, then `undo`, assert the target repo returns to its exact prior state; assert `undo` refuses when the file was hand-edited after `generate` (hash mismatch) unless `--force`; assert a created file is deleted (not left stale) on undo; assert undoing an earlier changeset is refused once a later changeset has touched the same file, naming the later changeset id.
- **Integration, dry-run consistency**: run with `--dry-run`, then without, against an unchanged working tree, and assert the printed plan matches the actual result.
- **Integration, provenance**: assert that repointing a pack's URL (while reusing the same version-folder name) or updating its pinned SHA causes a subsequent `generate` targeting a previously-injected file to refuse, rather than injecting blindly.
- **Integration, status/pending**: run `generate` against a descriptor with an `AI_IMPLEMENTATION` block, assert `scaffold status` exits non-zero and lists it; hand-edit the block's content, assert `scaffold status` now exits 0.

## Verification (end to end, once built)

1. `npm install && npm run build` at the workspace root.
2. `npm link` inside `packages/core` to install the `scaffold` binary locally.
3. Create a scratch fixture target repo, `scaffold init` it against a local fixture copy of `scaffold-templates-dotnet` (a local path is sufficient for manual testing).
4. `scaffold templates sync`, then `scaffold generate --manifest <fixture-manifest.toon> --dry-run` and inspect the printed plan, then re-run without `--dry-run` and inspect the actual generated and injected files plus the printed TOON report (`--json` to compare against plain JSON while debugging).
5. Re-run `scaffold generate` a second time with the identical manifest and confirm no files changed (idempotency).
6. Hand-edit a generated file, then run `scaffold undo <changeset-id>` and confirm it refuses due to hash mismatch; re-run with `--force` and confirm the fixture repo returns to its pre-generate state.
7. `npm test` at the workspace root for the full unit and integration suite.
8. Manually load the Claude Code Skill in a real Claude Code session against the fixture repo and drive one full natural-language request through phases 1 through 3, confirming the filled-in method body is correct and that a second `generate` run doesn't touch the filled block.
9. Run `scaffold status` right after a `generate` that left an `AI_IMPLEMENTATION` block unfilled and confirm a non-zero exit and correct file:line listing; fill the block and confirm `scaffold status` now exits 0.
10. With the Claude Code hooks registered in the fixture repo's `.claude/settings.json`, drive a session where Claude calls `generate` and then attempts to stop before filling every block; confirm the `Stop` hook blocks the turn with the correct reason, and that it allows the turn to end once all blocks are filled.
