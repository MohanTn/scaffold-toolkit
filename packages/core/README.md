# @mohantn/scaffold-core

A deterministic, LLM-agnostic scaffolding CLI (`scaffold`). It never calls an LLM: it renders Handlebars templates from a versioned template pack and injects marker-based boilerplate into existing files, then prints a TOON (or JSON) report a host coding agent can read back. See the monorepo root README for the overall architecture.

## Install

```
npm install -g @mohantn/scaffold-core
```

or invoke it without installing via `npx @mohantn/scaffold-core`.

## Commands

- `scaffold init [--project-type <type>] [--pack <name>=<url>@<version> ...]` — writes `.scaffold/config.json`. Without `--project-type`, the target repo is sniffed (`*.csproj`/`*.sln` → dotnet, a `react`/`next`/etc. dependency → js-family, `go.mod` → go, `pyproject.toml`/`requirements.txt` → python) with a single interactive prompt as a last resort. `--pack` seeds the `packs` map (repeatable, one per stack name).
- `scaffold templates sync [--update]` — clones or reuses the configured pack(s) into a local cache keyed by `sha256(normalizedUrl)/<resolvedSha>`. `--update` moves the pinned SHA forward to the remote's current HEAD.
- `scaffold templates list` — lists the version folders available in the configured pack(s)' cached checkout.
- `scaffold generate --manifest <file.toon|.json> [--dry-run] [--force] [--json]` — validates the intent manifest and the resolved pack's descriptor, renders `create`-mode targets, injects registration snippets at paired text markers, and prints a report of what was created/injected plus any `AI_IMPLEMENTATION` blocks still needing a host agent's attention.
- `scaffold status [--json]` — rescans `.scaffold/pending/*.json`; exits non-zero while any `AI_IMPLEMENTATION` block from a prior `generate` is still unfilled.
- `scaffold undo <changesetId> [--force]` — reverts a prior `generate` run: deletes files it created, restores files it modified to their exact prior content. Refuses on a hash mismatch (something else edited the file since) or if a later changeset also touched the same file, unless `--force`.
- `scaffold -v` / `--version` — prints the installed version.

## `.scaffold/config.json`

```json
{
  "projectType": "dotnet",
  "packs": {
    "backend": { "url": "https://github.com/org/scaffold-templates-dotnet.git", "version": "v10-minimal-api", "pinnedSha": "abc123..." }
  }
}
```

Template packs are separate git repositories, one folder per target-stack version, each holding Handlebars templates plus a `manifest.templates.json` descriptor. See the plan document / root README for the full descriptor and intent-manifest schemas.
