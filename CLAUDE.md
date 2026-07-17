# scaffold-toolkit — working conventions

## Determinism Guarantee

The scaffold CLI is **deterministic**: given the same manifest input and target repo state, it produces identical file writes, identical reports, and identical exit codes.

**Scope:** A single `scaffold generate` invocation. The CLI layer is deterministic; agent behavior (prompts, latency, multi-turn coherence) is out-of-scope.

**Enforcement layers (Claude Code hooks in `hooks/`):**
1. **PreToolUse hook (hard gate):** Fires before Write/Edit tool calls. Blocks attempts to create/edit pack-owned files outside `scaffold generate` (shells out to `scaffold check-edit`).
2. **PostToolUse hook (soft nudge):** Surfaces pending AI_IMPLEMENTATION blocks immediately after a generate call.
3. **Stop hook (hard gate):** Blocks turn-end if any AI_IMPLEMENTATION blocks are unfilled.
4. **UserPromptSubmit hook:** Injects a standing pack-ownership instruction each turn; never blocks.

Together, these hooks make it structurally impossible for an AI to bypass `scaffold generate` or leave blocks unfilled. Per-repo `.scaffold/conf.json` (`editEnforcement: "nudge"`) downgrades the PreToolUse gate to a soft nudge. The hooks prefer the `dist/cli.js` shipped next to them in the npm package and fall back to `scaffold` on PATH (`resolveScaffoldInvocation` in `hooks/packManifestReader.mjs`).

**Dry-run matches real-run:** The same code path is used for both; only final disk writes differ. For identical working-tree state, `--dry-run` output is guaranteed to match the real run.

## Repository layout

Single npm package (`@mohantn/scaffold-core`) at the repo root — no workspaces:

- `src/` — the TypeScript CLI engine (`tsc` → `dist/`, NodeNext ESM, `.js` import extensions).
- `hooks/` — Claude Code adapter hooks (`.mjs`, published with the package).
- `test/` — `unit/` and `integration/` in TS (run via tsx), `hooks/` in `.mjs`.
- `templates/templates-*` — vendored template packs. **Not** npm packages: never built, linted, or published; consumed by `scaffold init --pack <name>=<path>@<version>` straight off disk.

## Release pipeline

Every merge to `main` auto-publishes to npm. CI (`.github/workflows/ci.yml`) runs build, lint, and test plus the template-pack build-check; the `publish` job's `needs:` list gates on all of them. Node >= 20.12.

## Code conventions

- TypeScript with ESLint for linting.
- Build before test: integration tests exercise `dist/cli.js`.

## Template packs

- `scaffold init` consumes a pack as a local directory (`--pack <name>=<path>@<version>`, no git URL). It copies that directory into `.scaffold/cache` immediately and rewrites the pack's `path` in `.scaffold/config.json` to the cached copy — every later command (`generate`, `add`, `next`, `check-edit`, `bootstrap-markers`, …) reads that cached copy straight off disk, never the original `--pack` source again, so a repo scaffolded this way stays runnable even if the source directory (e.g. a sibling checkout) later becomes unreachable. `templates/templates-<name>` in this repo (e.g. `templates/templates-dotnet`) is the real, live source of truth for pack *authoring* here, updated by hand — `scaffold validate-pack` and the `tools/validate-build*.mjs` build-checks read it directly off disk with no cache step, by design, so they always see uncommitted edits; this is a separate path from `scaffold init`'s cache-copy above. The standalone repos (`scaffold-templates-dotnet`, `scaffold-templates-react`) remain the original publicly browsable sources these in-repo copies are periodically updated from, and the underlying git-URL pack engine (`templates sync` cloning into a cache) still exists for a hypothetical future non-vendored pack, but nothing in this repo's `init` flow uses it.
- Every pack ships `test_data/` fixtures (one manifest per distinct scenario, not per-file duplicates of the same entity) and a `tools/validate-build*.mjs`-style script that scaffolds them through the real CLI into a throwaway sample project, then actually builds/tests the output with the stack's own toolchain. `scaffold validate-pack` and render-only checks only prove `generate` didn't throw — they never catch a namespace mismatch, a missing `using`, or a wrong method name, all compile errors that only a real build step surfaces. Reference implementation: `templates/templates-dotnet/tools/validate-build-csharp-enterprise.mjs`.
- That build-check must run in CI (see `.github/workflows/ci.yml`'s `templates-dotnet-build-check` job) and gate the `publish` job's `needs:` list — a pack, new or extended, must not reach npm without it passing.
- Extending an existing pack for a new target (e.g. a cloud provider): a config-only swap is a manifest-`options` conditional in the existing templates (see `options.database.provider` in `csharp-enterprise`'s `AppCsproj.hbs`, or the `when`-gated cloud-provider targets); a real architectural addition is a new, additive sibling version folder with its own descriptor and non-colliding injection marker names, layered on top of the base version at `scaffold init`/`generate` time. Either way it needs its own `test_data` and its own passing build-check — it inherits none from the base version.

## Artifact scoping and `when` conditionals (descriptor conventions)

- Descriptor targets/injections may carry an `artifact` tag (kebab-case) and/or a `when` map (dot-path → scalar, strict equality, `false` also matches unset). A manifest without `artifacts` renders every entry — the legacy full-render contract; with `artifacts`, only listed tags render (untagged entries are the pseudo-tag `base`). Keep `when` to plain equality — no expressions — so selection stays trivially deterministic.
- `csharp-enterprise` declares `artifacts` as a **required** input: it must never be driven in legacy full-render mode (its per-artifact targets reference inputs like `methodName` a full render wouldn't carry). Follow this pattern for any future artifact-scoped pack.
- Appended injection snippets are frozen wiring by design: never put an `AI_IMPLEMENTATION` seam inside an `append`-strategy snippet (a hand-edit inside the zone breaks the hash trailer and refuses the next append). Put the editable seam in a create-mode file instead — see csharp-enterprise's partial-class `{Entity}Repository.{Method}.cs`.
- `scaffold add` is a pure compiler layer over `manifest new` + `generate`: new artifact kinds are a row in `src/add/addArtifact.ts`'s table, a subcommand entry in `src/cli.ts`'s `ARTIFACT_SUBCOMMANDS`, and templates + tagged descriptor entries in the pack (a startup consistency check keeps the two lists in sync).
