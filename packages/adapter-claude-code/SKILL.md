---
name: scaffold
description: Drive @mohantn/scaffold-core for deterministic boilerplate scaffolding (DTOs, endpoints, services, route registration, frontend API clients) from a configured template pack when the user's request splits into "boilerplate the CLI can render" + "logic only the user can describe." Use when the user is adding or extending a new file/resource/service that follows an existing target-stack pattern. Skip when the task is mostly modifying existing implementations, or is fully bespoke code with no target-stack boilerplate to render.
---

# scaffold — deterministic scaffolding for any coding agent

This Skill drives `@mohantn/scaffold-core`, the `scaffold` CLI. The CLI is LLM-agnostic: it never calls a model. Your three jobs each turn are:

1. Build an **intent manifest** describing the boilerplate to scaffold, in TOON against the published schema.
2. Run `scaffold generate` against the manifest — it renders files, injects marker-based registrations into existing files, and writes a TOON report on stdout.
3. Fill every `AI_IMPLEMENTATION_START/END` block the report marks as `empty: true` using your Edit tool.

The deterministic half (file rendering, marker-based injection, hash-trail idempotency) is the CLI's. The probabilistic half (turning this user's natural-language ask into a manifest, then implementing the join logic in each `AI_IMPLEMENTATION` block) stays in you. Do not invent boilerplate you could have asked the CLI to render — that re-introduces the latency and drift this tool exists to remove.

## One-time setup (first time this Skill runs in a target repo)

The two hook scripts that ship in this package — `hooks/post-tool-use.mjs` and `hooks/stop.mjs` — are what make phase-3 completion deterministic instead of prose-based. Without them, forgetting to fill an `AI_IMPLEMENTATION` block is up to your discipline at the end of a turn. With them, the `Stop` hook refuses to let the turn end while anything is still pending.

**Locate the two hooks** by searching common install locations, in this order:

1. The `hooks/` directory next to this `SKILL.md` (Claude Code Skills are loaded from a directory; the hooks ship alongside it)
2. `${CLAUDE_SKILL_DIR}/hooks/` if that env var is set
3. `<target-repo>/node_modules/@mohantn/scaffold-adapter-claude-code/hooks/` (source-checkout install of `scaffold-toolkit`, or a `npm install <local-tarball>` of the adapter)

A `find` over the user's `~/.claude/` tree is also acceptable. Note that this package is `private: true` and is *not* published to the public npm registry, so any candidate under `npm root -g` will always be empty; do not look there. Whichever you pick, verify both files exist before referencing them — a half-installed adapter should not silently produce a mistargeted `.claude/settings.json`. If none of the candidates resolve, the most likely cause is that the adapter is mirror-installed somewhere outside these defaults; ask the user to confirm their install path rather than guessing.

**Then merge the following into `<target-repo>/.claude/settings.json`**, using a procedure that does not clobber unrelated keys (`permissions`, `mcpServers`, etc. must survive):

1. If `.claude/settings.json` exists, read it and `JSON.parse` it; otherwise start from `{}`.
2. Ensure `obj.hooks ??= {}`.
3. For each entry below, append the entry to the corresponding array *only if* no existing entry has the same `command` string (that's the idempotency key — match on `command`, not on whole-object equality, because Claude Code may add new fields to entries over time).
4. `JSON.stringify(obj, null, 2)` and write the file back.

Entries to add (using absolute paths from Step 1):

```json
{
  "PostToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "node /<absolute>/hooks/post-tool-use.mjs"
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node /<absolute>/hooks/stop.mjs"
        }
      ]
    }
  ]
}
```

Wiring notes (these are not arbitrary; the hooks' behaviour and the Claude Code hooks reference determine them):

- `PostToolUse` is matched on `Bash` because the only tool that runs `scaffold generate` is Bash. The hook itself self-filters further (only commands whose string contains `scaffold generate` produce a nudge); `matcher: "Bash"` is the minimal correct entry.
- `Stop` has no matcher concept — every stop attempt runs it.
- Both hooks shell out to `scaffold status --json` and translate its exit code into the hooks protocol. `scaffold` must therefore be on `PATH` in the host shell that Claude's tools inherit.
- An entry is considered "already present" iff an existing object in the array has a `command` string equal to the one you're about to add. If `hooks.PostToolUse` or `hooks.Stop` already has a *different* entry whose origin you don't recognise, stop and ask the user before doing anything.

If you detect on a later invocation that `.claude/settings.json` no longer has these entries (the user edited it, or this is a fresh repo), re-run this merge step before doing anything else. The Stop hook is the load-bearing piece; without it, this Skill downgrades to the same prose-based non-determinism the tool exists to remove.

## Per-invocation workflow

### 1. Confirm the target repo is configured

Before running `generate`, read `.scaffold/config.json` and confirm:

- The file exists and has at least one entry under `packs` (keys are user-chosen stack names — typical are `"backend"` and `"frontend"`, but anything works).
- Each pack you're about to target has a `pinnedSha` set, not just `url` + `version` (the absence of `pinnedSha` means it has not been synced).
- Note the *keys* of `packs` — those are the legal values for the manifest's `targetStack` field. If the user says "scaffold a new backend endpoint" and the config has only a `frontend` pack, surface that mismatch before writing manifest.

If any check fails, surface a single message to the user:

- No config: tell them to run `npx -y @mohantn/scaffold-core init --project-type <type> --pack <name>=<url>@<version> [--pack ...]`. Don't invent a config yourself — `init` is the only path that sets up `pinnedSha` correctly and writes the file at the right path.
- No `pinnedSha`: tell them to run `npx -y @mohantn/scaffold-core templates sync [--update]` once.
- `targetStack` doesn't match any configured pack key: ask which pack the user wants before proceeding.

### 2. Build the intent manifest

Required fields, validated by the CLI's ajv schema:

| Field | Type | Required | Notes |
|---|---|---|---|
| `manifestSchemaVersion` | integer | yes | Always `1` for this schema generation. |
| `targetStack` | string | yes | A key into `.scaffold/config.json`'s `packs` map — e.g. `"backend"` or `"frontend"`. |
| `entity` | string | yes | PascalCase. The thing being scaffolded (e.g. `Invoice`, `OrderItem`, `UserProfile`). |
| `fields` | array | yes | `minItems: 1`. Each entry is `{ "name": string, "type": string }`. `name` is per-pack casing convention (camelCase for TS, PascalCase for .NET is fine for entity members). `type` is whatever the configured pack recognises. |
| `options` | object | no | `additionalProperties: true`, passed through verbatim into the Handlebars render context. The pack decides which keys it cares about (typical: `route`, `auth`, `audience`, `tag`). |

Example for a new .NET endpoint:

```json
{
  "manifestSchemaVersion": 1,
  "targetStack": "backend",
  "entity": "Invoice",
  "fields": [
    { "name": "id", "type": "guid" },
    { "name": "amount", "type": "decimal" },
    { "name": "issuedAt", "type": "datetime" }
  ],
  "options": { "route": "/api/invoices", "auth": true }
}
```

Notes on field shape:

- `fields` is not optional and not empty. If the user's request only names one field but their surrounding description makes clear there are more ("add an endpoint for invoices with line items"), infer the rest from the target pack's conventions and put them in. A manifest with one field that should have eight produces half-scaffolded files.
- `options` is the right place for *pack-side* knobs (route path, auth flag, whether to register the route, etc.), not for *entity* fields. Entity fields belong in `fields[]`.

### 3. Encode the manifest in TOON

The CLI accepts both `.toon` and `.json` and picks by file extension. Use `.toon` — for typical manifests (most are uniform arrays of small objects) it cuts tokens measurably, and that's why the artefact travels through your context window in this format.

Encode via one of these two paths:

**(a) Hand-write the TOON directly.** Determined by the published `@toon-format/toon` v2 syntax. The above manifest encodes to:

```
manifestSchemaVersion: 1
targetStack: backend
entity: Invoice
options:
  route: /api/invoices
  auth: true
fields[3]{name,type}:
  id,guid
  amount,decimal
  issuedAt,datetime
```

**(b) Encode via Node.** Write JSON first, then pipe through `npx -p @toon-format/toon`, which auto-fetches the package on first use so you don't have to assume it's already in `node_modules`:

```bash
npx -p @toon-format/toon -y -- node -e "console.log(require('@toon-format/toon').encode(JSON.parse(require('fs').readFileSync(0,'utf8'))))" < manifest.json > manifest.toon
```

Pick whichever you can produce without syntax errors. Both produce deterministic, lossless output. If path (a)'s hand-written TOON is rejected by the CLI's `decode` step with an opaque ajv error, fall back to (b) immediately; don't loop on guessing indentation.

### 4. Write the manifest to a temp file

A path like `/tmp/scaffold-manifest-<short-id>.toon`. Same file extension matters — the CLI dispatches TOON vs JSON by it.

### 5. Invoke `scaffold generate`

```bash
npx -y @mohantn/scaffold-core generate --manifest <tmp-file>
```

The CLI:

1. Decodes the manifest (TOON or JSON by extension) and validates it against the schema.
2. Validates the resolved pack's `manifest.templates.json` against its own schema and range-checks its `requires.scaffoldCli` semver range against the installed CLI version, failing fast before any file is touched.
3. Resolves every output path and rejects any that would escape the target repo root.
4. Renders `create`-mode targets from Handlebars (skipping or erroring per `mode: create | skip-if-exists | overwrite`).
5. For each injection target, locates its marker pair by ID. Missing, duplicated, or one-sided → hard error including file path and line number.
6. Writes `.scaffold/changes/<timestamp>.json` (prior content + post-write hash for every file touched) and `.scaffold/pending/<changeset-id>.json` (for any `AI_IMPLEMENTATION` block still empty after this run).
7. Prints the TOON report to stdout.

Run `--dry-run` first if you're unsure about a request — the dry-run path is the same code path; only the final disk-write/change-manifest steps are gated on `!dryRun`, so the printed plan matches a follow-up real run *exactly, provided the working tree is unchanged in between* (the tool does not lock or snapshot the repo across separate invocations).

### 6. Read the TOON report

The report's shape:

| Field | Type | Notes |
|---|---|---|
| `dryRun` | boolean | True if this was a planning run, no files were written. |
| `created` | array | Files written from a `create`-mode descriptor target. `{ file, mode, skipped }`. |
| `injected` | array | Marker-based injections. `{ file, marker, action }` where `action ∈ { "unchanged", "created", "updated" }`. `unchanged` means the hash trailer matched and nothing was rewritten. |
| `aiImplementation` | array | Every `AI_IMPLEMENTATION_START/END` block in a file this run touched. `{ file, startLine, endLine, content, empty }`. `empty: true` means the block currently contains the template's placeholder; you must fill it. `empty: false` means it already has real content (likely from your earlier work); leave it alone. The field is named `content` — early design prose and Skill templates may refer to it as `currentContent`; same thing. |
| `changesetId` | string | Present iff real files were written. The argument to `scaffold undo <id>`. |

Add `--json` to switch the report to plain JSON if a downstream tool needs it. The structure is otherwise identical.

### 7. Fill `AI_IMPLEMENTATION` blocks

This is phase 3 — the work only you (your host LLM) can do.

**For every entry in `aiImplementation` where `empty === true`:**

- The block lives at `file` at the reported `startLine`/`endLine`. Treat both pieces of information as advisory: pass the report's `content` field as the Edit tool's `old_string` parameter (it is the exact current interior of the block, including the placeholder text) and write the new implementation as the replacement. This is more robust than relying on line numbers, which can drift if unrelated edits shifted the file.
- If the same file contains two `AI_IMPLEMENTATION` blocks with byte-identical placeholder `content` (possible if the descriptor reuses a stub across blocks), `old_string` will not disambiguate — read the file first and use surrounding non-placeholder lines to make the search string unique.
- The replacement is the actual implementation: DTO ↔ controller wiring, service ↔ repository wiring, the join logic the user described, the validation rules, the auth check, etc.

**This is the load-bearing constraint: never replace a block where `empty === false`.** A subsequent `generate` (e.g., the user asked to add another field to an existing entity) reports `AI_IMPLEMENTATION` entries with `empty: false` for blocks you've already filled — that's just the scanner noticing those blocks still exist; skip them. Only `empty: true` entries are yours to fill. Editing a non-empty block throws away work you already did.

When all blocks marked `empty: true` are filled, run:

```bash
npx -y @mohantn/scaffold-core status --json
```

Expect exit code `0`, `resolvedAll: true`, and an empty `unresolved` array. That's the only condition under which your `Stop` hook will allow the turn to end. If it returns non-zero, `unresolved` lists every block you still need to fill.

### 8. Extending an existing entity

When the user says "add `customerId` to Invoice" or "add a second endpoint to the dashboard folder":

- Build a *delta* manifest. The same `targetStack` and `entity`, the new `fields[]` reflecting the change. Don't include fields that already exist.
- Run `generate` again. The injector treats existing marker blocks as already-resolved (the per-marker hash trailer in the file matches the byte sequence last written), so it does not overwrite your prior implementation — no `--force` is needed and `--force` should be avoided because it is the only path that silently overwrites work.
- Fill any new `empty: true` blocks from the report.

This is what makes the tool safe to call incrementally: each `generate` writes only the new boilerplate; existing implementations stay byte-identical.

## Type-vocabulary cheat sheet

`type` strings inside `fields[].type` are interpreted by the configured pack, not by the CLI. They are conventions, not enforced values — when in doubt, check the pack.

- **.NET packs** typically recognise: `guid`, `string`, `int`, `long`, `decimal`, `bool`, `datetime`, `DateOnly`, `Uri`, `enum:<Name>`.
- **React/TS packs** typically recognise: `string`, `number`, `boolean`, `Date`, `UUID`, `enum:<Name>`.

If the pack is unfamiliar, run `scaffold templates list` first and read its README / templates folder — those are the authoritative references for what `type` strings the pack renders.

## Common failure modes

- `scaffold: no pack configured for targetStack "<X>"` — `packs` in `.scaffold/config.json` has no `<X>` key. Tell the user.
- `scaffold: pack "<X>" has not been synced yet — run "scaffold templates sync" first` — `pinnedSha` missing on that pack. Tell them to run `templates sync`.
- `scaffold: template pack version "<X>" not found in cache` — the configured `version` folder doesn't exist in the cache. Run `templates sync --update` or pick a different one.
- `scaffold: <file>: marker "<X>" content differs from what was previously injected — refusing without --force` — something has hand-edited the marker block. Do **not** pass `--force`. The prior content was either your prior work or a developer's manual edit; either way, blind overwrite is wrong. Ask the user what they want.
- `scaffold: this file was scaffolded under <oldPackVersion>; migrating to <newPackVersion> requires a manual marker migration` — provenance changed (the pack's URL was repointed, `--update` moved `pinnedSha` forward, etc.). There is no auto-migration in v1. Tell them to manually cut over.
- Status exit code non-zero at end of turn: list of unresolved blocks in `unresolved[]`. Fill those, then run `status` again.

## What you are not allowed to do

- Skip step 1. Running `generate` against an un-configured repo produces "no pack configured" rather than something useful.
- Hand-author or rewrite anything under `.scaffold/changes/` or `.scaffold/pending/`. They're authoritative state.
- Edit a target file's `SCAFFOLD_*` markers or the contents between them — that's the injector's territory. Use the `AI_IMPLEMENTATION_*` markers for fill-in.
- Pass `--force` to `generate` or `undo` without an explicit user instruction and a verbal explanation of what gets discarded.
- Re-fill a block where the report says `empty: false`. Ever.
- Proceed past a non-zero `scaffold status` exit code at end of turn. The Stop hook will block anyway; ignoring it just means a wasted token pass.
- Discover a target repo's hooks aren't installed and continue without re-running the one-time setup. Without the Stop hook, this Skill is no stronger than prose.
