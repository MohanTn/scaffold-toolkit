---
name: scaffold
description: Drive @mohantn/scaffold-core for deterministic boilerplate scaffolding (DTOs, endpoints, services, route registration, frontend API clients) from a configured template pack when the user's request splits into "boilerplate the CLI can render" + "logic only the user can describe." Use when the user is adding or extending a new file/resource/service that follows an existing target-stack pattern. Skip when the task is mostly modifying existing implementations, or is fully bespoke code with no target-stack boilerplate to render.
---

# scaffold — deterministic scaffolding for any coding agent

This Skill drives `@mohantn/scaffold-core`, the `scaffold` CLI, from GitHub Copilot CLI. The CLI is LLM-agnostic: it never calls a model. Your three jobs each turn are:

1. Build an **intent manifest** describing the boilerplate to scaffold, in TOON against the published schema.
2. Run `scaffold generate` against the manifest — it renders files, injects marker-based registrations into existing files, and writes a TOON report on stdout.
3. Fill every `AI_IMPLEMENTATION_START/END` block the report marks as `empty: true` using your file-editing tool.

The deterministic half (file rendering, marker-based injection, hash-trail idempotency) is the CLI's. The probabilistic half (turning this user's natural-language ask into a manifest, then implementing the join logic in each `AI_IMPLEMENTATION` block) stays in you. Do not invent boilerplate you could have asked the CLI to render — that re-introduces the latency and drift this tool exists to remove.

## One-time setup (first time this Skill runs in a target repo)

Four hook scripts ship in this package: `hooks/pre-tool-use.mjs`, `hooks/post-tool-use.mjs`, `hooks/agent-stop.mjs`, and `hooks/session-start.mjs`. Together they make both phase-3 completion *and* the "always go through `scaffold generate`" rule deterministic instead of prose-based:

- `preToolUse` (`pre-tool-use.mjs`) is the hard gate. It fires *before* a file-create/edit tool call runs and blocks it outright when the target is a pack-owned file being written directly, or edited outside an `AI_IMPLEMENTATION` interior. This is the only hook that can stop a hand-written, un-scaffolded file from ever reaching disk — `postToolUse` and `agentStop` both fire after the fact and can only nudge or block the *turn*, not the write itself.
- `sessionStart` (`session-start.mjs`) is a complementary early-warning layer, not enforcement: at session start, if `.scaffold/config.json` exists, it injects a short standing instruction into context reminding you that pack-owned files are gated. This makes a `preToolUse` block unsurprising if you hit one, but it never blocks anything itself. (The Claude Code adapter delivers the same instruction per turn via its `UserPromptSubmit` hook; Copilot fires a `userPromptSubmitted` event but does not process that event's output, so the once-per-session `sessionStart` injection is the available equivalent.)
- `postToolUse` (`post-tool-use.mjs`) carries two self-filtering jobs: the end-of-generate nudge for unfilled `AI_IMPLEMENTATION` blocks (as on Claude Code), plus the pack coding-standards guidance after you edit an `AI_IMPLEMENTATION` block — on Claude Code that guidance rides the PreToolUse hook, but Copilot's `preToolUse` output cannot carry `additionalContext`, so here it arrives right after your fill, in time to review the fill against the pack's rules.
- `agentStop` (`agent-stop.mjs`) is the end-of-turn hard gate for unfilled `AI_IMPLEMENTATION` blocks, equivalent to the Claude Code adapter's `Stop` hook.

Without all of these, forgetting to fill an `AI_IMPLEMENTATION` block (or hand-writing a pack-owned file instead of running `generate`) is up to your discipline. With them, both mistakes are structurally blocked rather than merely discouraged.

**Locate the hooks** by searching common install locations, in this order:

1. The `hooks/` directory next to this `SKILL.md` (the hooks ship alongside it)
2. `<target-repo>/node_modules/@mohantn/scaffold-adapter-copilot-cli/hooks/` (source-checkout install of `scaffold-toolkit`, or a `npm install <local-tarball>` of the adapter)

Note that this package is `private: true` and is *not* published to the public npm registry, so any candidate under `npm root -g` will always be empty; do not look there. Whichever you pick, verify all four files exist before referencing them — a half-installed adapter should not silently produce a mistargeted hooks config. If neither candidate resolves, the most likely cause is that the adapter is mirror-installed somewhere outside these defaults; ask the user to confirm their install path rather than guessing.

**Then write `<target-repo>/.github/hooks/scaffold-toolkit.json`** (create the directory if needed) with the following content, substituting absolute paths from the step above:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "type": "command", "bash": "node \"/<absolute>/hooks/pre-tool-use.mjs\"", "timeoutSec": 15 }
    ],
    "postToolUse": [
      { "type": "command", "bash": "node \"/<absolute>/hooks/post-tool-use.mjs\"", "timeoutSec": 15 }
    ],
    "agentStop": [
      { "type": "command", "bash": "node \"/<absolute>/hooks/agent-stop.mjs\"", "timeoutSec": 15 }
    ],
    "sessionStart": [
      { "type": "command", "bash": "node \"/<absolute>/hooks/session-start.mjs\"", "timeoutSec": 15 }
    ]
  }
}
```

Wiring notes (these are not arbitrary; the hooks' behaviour and the Copilot CLI hooks reference determine them):

- Config schema, event names, and file location are per https://docs.github.com/en/copilot/reference/hooks-reference (fetched 2026-07-15). Repo-level `.github/hooks/*.json` is the deliberate choice over user-level `~/.copilot/hooks/`: it's committed to the repo and applies to every teammate using Copilot CLI there automatically — the same one-time-per-repo model the Claude Code adapter uses when it merges entries into a target repo's `.claude/settings.json`.
- Because the config is a *dedicated file* (not a shared settings file), there is no merge problem: write it wholesale, deterministically. If the file already exists with exactly this shape, leave it; if it exists with different content, overwrite only when the differing content is clearly a stale version of this same config (old absolute paths) — otherwise stop and ask the user.
- Copilot's hook config has no per-tool matcher concept; every event firing runs the scripts. Each script self-filters (e.g. `post-tool-use.mjs` only acts on shell commands containing `scaffold generate` or on edits touching an `AI_IMPLEMENTATION` block), so unrelated tool calls cost one fast `existsSync` no-op.
- All hooks except `session-start.mjs` shell out to the target repo's `scaffold status --json` / `scaffold check-edit`; `scaffold` must therefore be on `PATH` in the host shell Copilot's tools inherit (`session-start.mjs` never shells out to anything).
- `preToolUse` is the one hook here that can actually stop a file from being written or edited at all — `postToolUse`/`agentStop` only ever nudge or block the *turn*, after the write already happened. Treat it as the load-bearing piece for the "always go through `scaffold generate`" rule, the same way `agentStop` is load-bearing for "always fill `AI_IMPLEMENTATION` blocks before ending the turn."
- `pre-tool-use.mjs` never emits an explicit `permissionDecision: "allow"` — it prints `{}` on the allow path so Copilot's own permission flow for unrelated writes stays untouched, and denies with `{ permissionDecision: "deny", permissionDecisionReason }` only when `scaffold check-edit` blocks (fail-closed if check-edit itself is unreachable).

If you detect on a later invocation that `.github/hooks/scaffold-toolkit.json` is missing or no longer points at existing script files (the user edited it, or this is a fresh repo), re-run this setup step before doing anything else. The `agentStop` hook is the load-bearing piece; without it, this Skill downgrades to the same prose-based non-determinism the tool exists to remove.

## Adopting an existing (brownfield) repo

If the target repo already has hand-written code that a configured pack should now own — the user is retrofitting `scaffold` onto a repo instead of starting from an empty one — run this once per repo, after `.scaffold/config.json` exists but before the first `generate`:

```bash
npx -y @mohantn/scaffold-core bootstrap-markers --dry-run
```

Review the plan, then drop `--dry-run` to write. This maps each configured pack's `targets[]`/`injections[]` to the repo's real files (persisted to `.scaffold/config.json`'s `adoptedPaths`, so `preToolUse`/`check-edit` gate them exactly like generated files) and bootstraps empty `SCAFFOLD:<marker>:START/END` pairs into existing files where an anchor is known.

Read the report's channels before deciding what to do next:

- `placed` / `alreadyPresent` — marker pairs written this run, or already present from a previous run. No action needed.
- `pendingGenerate` — informational, not an error: the anchor file doesn't exist yet, but it's one of the pack's own `generate` targets, so the marker pair arrives already in place the first time `scaffold generate` runs. Nothing to do by hand.
- `needsManual` — genuinely ambiguous (zero or multiple candidate files, none uniquely matching the group's markers or anchor pattern). Surface the reason to the user and place the marker pair by hand (or have them do it) before proceeding — don't guess which file it means.
- `unsupportedPacks` — the configured pack version has no anchor catalog entry, built-in or descriptor-declared. Nothing this command can do for that slot; proceed straight to `generate`.

Exit code is `1` while any `needsManual`/`mappingNeedsManual` entries remain, `0` otherwise — the same shape as `status`.

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

- The block lives at `file` at the reported `startLine`/`endLine`. Treat both pieces of information as advisory: pass the report's `content` field as your edit tool's old-string parameter (it is the exact current interior of the block, including the placeholder text) and write the new implementation as the replacement. This is more robust than relying on line numbers, which can drift if unrelated edits shifted the file.
- If the same file contains two `AI_IMPLEMENTATION` blocks with byte-identical placeholder `content` (possible if the descriptor reuses a stub across blocks), the old-string will not disambiguate — read the file first and use surrounding non-placeholder lines to make the search string unique.
- The replacement is the actual implementation: DTO ↔ controller wiring, service ↔ repository wiring, the join logic the user described, the validation rules, the auth check, etc.

**This is the load-bearing constraint: never replace a block where `empty === false`.** A subsequent `generate` (e.g., the user asked to add another field to an existing entity) reports `AI_IMPLEMENTATION` entries with `empty: false` for blocks you've already filled — that's just the scanner noticing those blocks still exist; skip them. Only `empty: true` entries are yours to fill. Editing a non-empty block throws away work you already did.

If you need to re-orient on open work without a fresh `generate` call — a later turn, after context got compacted, or just to double-check before ending — run:

```bash
npx -y @mohantn/scaffold-core next
```

`next` reshapes the same rescan `status` uses into a compact digest instead of a bare pass/fail: `{ done, blocks: [{ file, startLine, endLine, required, placeholder }] }` (add `--json` for plain JSON). `placeholder` is the block's exact current interior — use it as your edit tool's old-string the same way you'd use the generate report's `content` field. This saves you from re-reading every generated file to relocate open blocks. Exits `0` when `done`, `1` otherwise, matching `status`'s exit code.

When all blocks marked `empty: true` are filled, run:

```bash
npx -y @mohantn/scaffold-core status --json
```

Expect exit code `0`, `resolvedAll: true`, and an empty `unresolved` array. That's the only condition under which your `agentStop` hook will allow the turn to end. If it returns non-zero, `unresolved` lists every block you still need to fill.

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

If no pack exists yet for the stack the user wants, that's pack-authoring, not this Skill's consuming workflow: point them at `scaffold pack new --dir <path> --pack-version <version> [--stack <label>]`, which writes an empty, schema-valid `manifest.templates.json` plus a `tools/validate-build.mjs` stub — the smallest thing `scaffold validate-pack` accepts unmodified. Don't hand-author a descriptor yourself; the author still has to add real `.hbs` templates, `test_data/` fixtures, and a real build-check by hand afterward.

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
- Directly create or edit a pack-owned file (any path matching a configured pack's `targets[].output` or `injections[].file`) instead of running `scaffold generate`. The `preToolUse` hook blocks this structurally now — it is not merely discouraged — but don't attempt it and rely on the hook to catch you; plan to run `generate` from the start.
- Edit a target file's `SCAFFOLD_*` markers or the contents between them — that's the injector's territory. Use the `AI_IMPLEMENTATION_*` markers for fill-in. `preToolUse` blocks an edit that lands in a `SCAFFOLD:<marker>` injection region the same way it blocks a raw write.
- Pass `--force` to `generate` or `undo` without an explicit user instruction and a verbal explanation of what gets discarded.
- Re-fill a block where the report says `empty: false`. Ever.
- Proceed past a non-zero `scaffold status` exit code at end of turn. The `agentStop` hook will block anyway; ignoring it just means a wasted token pass.
- Discover a target repo's hooks aren't installed and continue without re-running the one-time setup. Without the `preToolUse` and `agentStop` hooks, this Skill is no stronger than prose.
