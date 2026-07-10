# scaffold-toolkit

An npm-workspaces monorepo for `scaffold`, a deterministic, LLM-agnostic scaffolding CLI, plus the host adapters that let AI coding agents drive it.

## Packages

- `packages/core` (`@mohantn/scaffold-core`) — the portable `scaffold` CLI. Never calls an LLM: it validates an intent manifest, resolves a versioned template pack, renders Handlebars templates, injects registration snippets into existing files via paired text markers, and prints a JSON/TOON report. See `packages/core/README.md`.
- `packages/adapter-claude-code` — a Claude Code Skill that turns natural-language requests into intent manifests and shells out to the core CLI. Not yet built.
- `packages/adapter-copilot-cli` — a `gh` CLI extension exposing the same touchpoints inside Copilot Chat. Not yet built.

Template packs (the Handlebars templates plus their `manifest.templates.json` descriptors, per target stack) live in their own separate repositories, not in this monorepo: `scaffold-templates-dotnet` and `scaffold-templates-react`.

## Development

```
npm install
npm run build
npm run lint
npm test
```

## Release

Every merge to `main` runs the full test matrix, then bumps the patch version of every publishable workspace and publishes to the public npm registry. See `.github/workflows/ci.yml`.
