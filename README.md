# @mohantn/scaffold-core

A deterministic, LLM-agnostic scaffolding CLI (`scaffold`). It never calls an LLM: it renders Handlebars templates from a versioned template pack and injects marker-based boilerplate into existing files, then prints a TOON (or JSON) report a host coding agent can read back. The agent's only job is filling the `AI_IMPLEMENTATION` blocks — the business-logic seams — instead of re-generating boilerplate token by token.

## Install

```
npm install -g @mohantn/scaffold-core
```

or invoke it without installing via `npx @mohantn/scaffold-core`.

## Quick start

```sh
scaffold init --pack backend=templates/templates-dotnet@csharp-enterprise
scaffold add feature --name Product --properties "Name:string,Price:decimal,IsActive:bool"
scaffold add custom --name GetProductsWithFilter --return-type PagedResult \
  --parameters "page:int,pageSize:int" --method GET --target-controller ProductsController
scaffold next     # lists the AI_IMPLEMENTATION blocks awaiting business logic
scaffold status   # exits non-zero while any tracked block is unfilled
```

Every `add` run is deterministic: same flags + same repo state ⇒ identical files, identical report, identical exit code. `--dry-run` uses the exact same code path and only skips the final disk writes.

## `scaffold add` — the artifact command family

Each subcommand compiles its flags into an artifact-scoped intent manifest and runs the same generate pipeline as `scaffold generate`. All of them accept `--dry-run --force --json --format doc --template-set <slot>`.

| Command | Generates |
|---|---|
| `add feature --name <Entity> --properties "Name:type,…" [--operations Create,Read,Update,Delete] [--db <scope>] [--combine] [--namespace <ns>]` | Entity, DTO, EF config, repository (split or combined layout), controller, and the chosen CRUD commands/queries + handlers + validators + tests, with DI/DbSet wiring injected |
| `add custom --name <Operation> --return-type <T> [--parameters "a:int,…"] [--method GET] [--route <tpl>] --target-controller <Name> [--is-command] [--combine]` | Query/Command + handler, a partial-class repository method file (the editable seam), plus the action injected into the existing controller and the signature into the existing repository interface |
| `add domain-event --name <EventName> [--entity <Entity>]` | INotification record + handler stub |
| `add factory --entity <Entity>` | Domain factory + DI registration |
| `add helper --name guard\|crypto` | Guard clauses / crypto utilities |
| `add cloud-provider --provider aws\|azure\|gcp` | `ICloudStorageProvider` + the provider implementation (real SDK), DI + csproj package injection |
| `add scheduler-job --name <JobName> [--scheduler quartz\|hangfire]` | BackgroundService-based scheduled job + DI registration |
| `add health-check --name <CheckName>` | `IHealthCheck` class + `/health` registration |
| `add outbox-processor` | Outbox message entity + EF config + polling dispatcher |

`--combine` puts the repository interface and implementation in a single file (two namespace blocks, so references are identical either way). Set it once for the whole repo via pack `defaults` (below) instead of repeating the flag.

Extending **existing** controllers and repositories never rewrites code: new members are injected at `SCAFFOLD:<MARKER>:START/END` comment pairs (`CONTROLLER_ACTIONS`, `REPO_INTERFACE_METHODS`, `SERVICES`, `HEALTH_CHECKS`, …), idempotently, with a content-hash trailer. Brownfield files get their markers placed once by `scaffold bootstrap-markers`.

## Low-level commands

- `scaffold init [--project-type <type>] [--pack <name>=<path>@<version> ...]` — writes `.scaffold/config.json`. `--pack` seeds the `packs` map as local-directory entries (git URLs are rejected; the `url`-pack engine still exists underneath for a future non-vendored pack); each seeded directory is copied into `.scaffold/cache` immediately and the pack's `path` is rewritten to that cached copy, so the repo stays runnable even if the original `--pack` source later becomes unreachable.
- `scaffold manifest new --stack <slot> [--entity <Name>] [--field name:type ...] [--option path=value ...] [--input name=value ...] [--artifact <tag> ...] [--out <file>]` — builds a schema-validated intent manifest; `--artifact` scopes the render to those descriptor tags (untagged entries are `base`).
- `scaffold generate --manifest <file.toon|.json> [--dry-run] [--force] [--json] [--format doc]` — validates the manifest + pack descriptor, renders the selected `create`-mode targets, injects registration snippets at markers, and reports created/injected files plus pending `AI_IMPLEMENTATION` blocks.
- `scaffold status [--json]` — exits non-zero while any tracked block from a prior generate is unfilled (empty, or tagged `:required` and still holding its shipped placeholder).
- `scaffold next [--json]` — the agent-facing worklist: each open block's file/lines/placeholder, plus the pack's `conventions.md` preamble when available.
- `scaffold undo <changesetId> [--force]` — reverts a prior generate run (deletes created files, restores modified ones; refuses on hash mismatch).
- `scaffold bootstrap-markers [--pack-version <v>] [--dry-run] [--json]` — one-time, idempotent brownfield adoption: places empty marker pairs at pack-declared anchors and persists real file paths into `adoptedPaths`.
- `scaffold validate-pack --pack <dir> [--pack-version <v>] --manifest <file> [--json]` — smoke-tests a pack via a real generate into a synthesized target repo.
- `scaffold templates sync|list`, `scaffold pack new`, `scaffold check-edit` — pack cache management, pack authoring skeletons, and the edit gate the hooks shell out to.

## `.scaffold/config.json`

```json
{
  "projectType": "dotnet",
  "packs": {
    "backend": {
      "path": ".scaffold/cache/<hash>/local",
      "version": "csharp-enterprise",
      "defaults": { "options": { "combine": true, "database": { "provider": "postgres" } } }
    }
  }
}
```

- A pack entry is either `path` (local directory, read off disk — `init` writes this as a `.scaffold/cache` entry it just copied the `--pack` source into) or `url` (git remote, cached by `templates sync`, pinned by `pinnedSha`) — never both.
- `defaults` merge UNDER every manifest for that slot (explicit manifest keys win; `options` merges one level deep) — the place for repo-wide choices like `options.combine` or `options.database.provider`.
- `pathConfig` / `companyProjectName` persist a brownfield repo's real layout (usually written by `bootstrap-markers`); the pack's own `pathConfig` declaration is the fallback.
- `adoptedPaths` maps descriptor entries to real brownfield files so `check-edit` gates them identically to generated ones.

## AI-agent enforcement (Claude Code hooks)

The published package ships `hooks/` for Claude Code:

| Hook | Event | Effect |
|---|---|---|
| `hooks/pre-tool-use.mjs` | PreToolUse | Hard gate: blocks Write/Edit on pack-owned files outside `AI_IMPLEMENTATION` interiors (shells out to `scaffold check-edit`) |
| `hooks/post-tool-use.mjs` | PostToolUse | Soft nudge: surfaces unfilled blocks right after a `scaffold generate`/`add` run |
| `hooks/stop.mjs` | Stop | Hard gate: blocks turn-end while `scaffold status` reports unfilled blocks |
| `hooks/user-prompt-submit.mjs` | UserPromptSubmit | Injects the standing pack-ownership instruction each turn |

`.scaffold/conf.json` with `{"editEnforcement": "nudge"}` downgrades the PreToolUse gate to advisory. The hooks prefer the `dist/cli.js` shipped next to them and fall back to `scaffold` on PATH.

## Determinism guarantee

For one `scaffold generate`/`scaffold add` invocation against a given repo state: identical file writes, identical report, identical exit code — regardless of which agent (or human) drives it. Artifact/`when` selection is pure set membership over the descriptor, the `add` compilers are pure flag→manifest functions, dry-run shares the real code path, and marker injections are content-hash idempotent. Template packs prove their output compiles via real build checks in CI (`templates/templates-dotnet/tools/validate-build*.mjs`), which gate every npm publish.
