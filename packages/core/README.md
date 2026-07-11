# @mohantn/scaffold-core

A deterministic, LLM-agnostic scaffolding CLI (`scaffold`). It never calls an LLM: it renders Handlebars templates from a versioned template pack and injects marker-based boilerplate into existing files, then prints a TOON (or JSON) report a host coding agent can read back. See the monorepo root README for the overall architecture.

## Install

```
npm install -g @mohantn/scaffold-core
```

or invoke it without installing via `npx @mohantn/scaffold-core`.

## Commands

- `scaffold init [--project-type <type>] [--pack <name>=<path>@<version> ...]` — writes `.scaffold/config.json`. Without `--project-type`, the target repo is sniffed (`*.csproj`/`*.sln` → dotnet, a `react`/`next`/etc. dependency → js-family, `go.mod` → go, `pyproject.toml`/`requirements.txt` → python) with a single interactive prompt as a last resort. `--pack` seeds the `packs` map (repeatable, one per stack name) as a local-directory entry, e.g. `--pack backend=packages/templates-dotnet@v8-controller`; a git-URL-shaped spec is rejected with a pointer to this syntax.
- `scaffold templates sync [--update]` — for a `url`-based pack, clones or reuses it into a local cache keyed by `sha256(normalizedUrl)/<resolvedSha>`, and `--update` moves the pinned SHA forward to the remote's current HEAD. For a `path`-based pack (what `scaffold init` writes), this is a no-op — there is no clone or cache, the pack is read straight off disk on every `generate` — but still safe to run.
- `scaffold templates list` — lists the version folders available in the configured pack(s): for a `path`-based pack, the directory's own version folders; for a `url`-based pack, its cached checkout.
- `scaffold generate --manifest <file.toon|.json> [--dry-run] [--force] [--json]` — validates the intent manifest and the resolved pack's descriptor, renders `create`-mode targets, injects registration snippets at paired text markers, and prints a report of what was created/injected plus any `AI_IMPLEMENTATION` blocks still needing a host agent's attention. Rejects any `overwrite`-mode target that doesn't already exist on disk (create a new file via a `create` or `skip-if-exists` target first); exits non-zero and writes nothing on this gate rejection, ensuring a misaligned pack descriptor and target repo can never create new files in overwrite mode.
- `scaffold status [--json]` — rescans `.scaffold/pending/*.json`; exits non-zero while any tracked `AI_IMPLEMENTATION` block from a prior `generate` is still unfilled. A block is tracked when it shipped empty, or when the pack tagged its start marker `:required` (`SCAFFOLD:AI_IMPLEMENTATION:START:required` / `AI_IMPLEMENTATION_START:required`) — the business-logic seams the host agent must complete even though the shipped placeholder already compiles. A block resolves once its content changes from the shipped placeholder.
- `scaffold validate-pack --pack <dir> [--pack-version <version>] --manifest <file> [--json]` — smoke-tests a local template pack by running a *real* generate against a synthesized throwaway target repo (host-provided injection targets like `Program.cs` are stood up with empty marker pairs first). Unlike a render-only check it exercises injection-path resolution, the comment-syntax table, the marker scanner, and the descriptor `requires` check. Validates every version folder unless `--pack-version` narrows it; exits non-zero if any version fails.
- `scaffold undo <changesetId> [--force]` — reverts a prior `generate` run: deletes files it created, restores files it modified to their exact prior content. Refuses on a hash mismatch (something else edited the file since) or if a later changeset also touched the same file, unless `--force`.
- `scaffold bootstrap-markers [--pack-version <version>] [--dry-run] [--json]` — bootstraps empty `SCAFFOLD:<marker>:START/END` pairs into a brownfield repo's existing source files, one-time and idempotent, so a plain `scaffold generate` can later find and fill them. Without `--pack-version`, it reads every entry in `.scaffold/config.json`'s `packs` map and runs one pass per configured pack; `--pack-version` runs a single pass against that version directly (no config file required). Exits non-zero while any marker is left `needs-manual`.

  The catalog is keyed by the exact configured pack version, not the coarse `projectType` bucket, since the marker set and `Program.cs` zones differ between a base pack and its GCP sibling. Four versions are known, matching `packages/templates-dotnet`'s own marker table:

  | Pack version | `Program.cs` builder-zone markers | `Program.cs` app-zone markers |
  |---|---|---|
  | `v8-controller` | `DI` | *(none)* |
  | `v10-minimal-api` | `DI` | `MIDDLEWARE`, `ROUTES` |
  | `v8-controller-gcp` | `GSM`, `DI`, `PUBSUB`, `SAGAS` | *(none)* |
  | `v10-minimal-api-gcp` | `GSM`, `DI`, `PUBSUB`, `SAGAS` | `MIDDLEWARE`, `ROUTES` |

  Every version also places `DBSETS` into `AppDbContext.cs` and `REPOSITORIES` into `ApplicationServiceCollectionExtensions.cs`, both found by locating the class's own opening brace rather than a single-line anchor (no universal single-line anchor exists in either file). Within a zone, markers are always placed as one contiguous block in the order listed above: `GSM` precedes `DI` because `InfrastructureServiceCollectionExtensions.cs`'s `AddInfrastructure` reads a connection-string config key at registration time that `GSM` populates, and `MIDDLEWARE` precedes `ROUTES` to match request-pipeline ordering.

  Placement never guesses: zero or multiple candidate files for a marker group, an ambiguous anchor line, or a one-sided/duplicated existing marker all fall back to a `needs-manual` report entry (with a reason) rather than writing anything for that marker. A marker already present anywhere in the file — even hand-moved by a developer — is left untouched and reported `already-present`, never duplicated. Inside a git working tree, a target file must be tracked and clean (`git status --porcelain` empty) before it's touched; a dirty or untracked file is reported `needs-manual` with a git-state reason instead. Outside a git working tree this check is skipped entirely.

  A configured pack slot whose version has no catalog entry at all (e.g. a `frontend` slot pointing at a non-dotnet pack) is reported under a separate `unsupportedPacks` field, never `needsManual` — there is no per-marker action to take for a slot the catalog doesn't cover, so it never blocks a clean exit once every actionable marker elsewhere is resolved.
- `scaffold -v` / `--version` — prints the installed version.

## `.scaffold/config.json`

```json
{
  "projectType": "dotnet",
  "packs": {
    "backend": { "path": "packages/templates-dotnet", "version": "v10-minimal-api" }
  }
}
```

A pack entry is either `path` (a local directory, read straight off disk — what `scaffold init` writes) or `url` (a git-clonable remote, resolved through `templates sync` into a local cache and pinned by `pinnedSha`) — never both. Either way it's one folder per target-stack version, each holding Handlebars templates plus a `manifest.templates.json` descriptor. See the plan document / root README for the full descriptor and intent-manifest schemas.
