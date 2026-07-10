# scaffold-toolkit

An npm-workspaces monorepo for `scaffold`, a deterministic, LLM-agnostic scaffolding CLI, plus the host adapters that let AI coding agents drive it.

## Packages

- `packages/core` (`@mohantn/scaffold-core`) — the portable `scaffold` CLI. Never calls an LLM: it validates an intent manifest, resolves a versioned template pack, renders Handlebars templates, injects registration snippets into existing files via paired text markers, and prints a JSON/TOON report. See `packages/core/README.md`.
- `packages/adapter-claude-code` — a Claude Code Skill (`SKILL.md`) plus `PostToolUse`/`Stop` hooks that turn natural-language requests into intent manifests, shell out to the core CLI, fill the reported `AI_IMPLEMENTATION` blocks, and refuse to end the turn while any required block is still unfilled. `private: true` (not published).
- `packages/adapter-copilot-cli` — a `gh` CLI extension exposing the same touchpoints inside Copilot Chat, with matching `postToolUse`/`agentStop` hooks registered via `gh scaffold install-hooks`.

## The deterministic loop

The CLI owns the boilerplate; the host LLM owns only the business logic. A run creates every file and injects every registration deterministically, then leaves `AI_IMPLEMENTATION` blocks for the agent to fill. Blocks a pack tags `:required` (the business-logic seams) are tracked by `scaffold status`, which exits non-zero — and the adapters' `Stop`/`agentStop` hooks block the turn — until the agent changes them. So the LLM never re-types a DTO, controller, or DI wiring; it only writes the parts a template cannot know.

Pack authors can smoke-test a local pack with a real generate (injection included, not just rendering) via `scaffold validate-pack --pack <dir> --manifest <sample>`.

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
