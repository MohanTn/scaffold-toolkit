# scaffold-toolkit — working conventions

## Release pipeline

Every merge to `main` auto-publishes to npm. The CI pipeline runs build, lint, and test before publishing.

## Setup for pipeline-worker

Pipeline-worker creates an isolated worktree and needs to resolve dependencies correctly. Ensure that:

- `npm install` is run from the root to populate both root `node_modules` and `packages/core/node_modules`
- The root-level `node_modules` must contain all workspace dependencies
- Node >= 20.12
- TypeScript ESM with `.js` import extensions

When pipeline-worker runs checks, it symlinks the root `node_modules` into the worktree. The workspace structure (with packages/core/node_modules) is preserved to ensure correct module resolution per package.

## Code conventions

- TypeScript with ESLint for linting
- Monorepo structure with workspaces in `packages/`
- All scripts (build, lint, test) run against all workspaces

## Template packs

- `scaffold init` consumes a pack as a local directory (`--pack <name>=<path>@<version>`, no git URL) read straight off disk — no clone, no cache. `packages/templates-<name>` in this monorepo (e.g. `packages/templates-dotnet`) is the real, live source of truth for that consumption here — kept out of the root `workspaces` array (never built, linted, tested, or published as a workspace package), updated by hand. The standalone repos (`scaffold-templates-dotnet`, `scaffold-templates-react`) remain the original publicly browsable sources these in-repo copies are periodically updated from, and the underlying git-URL pack engine (`templates sync` cloning into a cache) still exists for a hypothetical future non-vendored pack, but nothing in this repo's `init` flow uses it.
- Every pack, standalone or in-repo, ships `test_data/` fixtures (one manifest per distinct scenario, not per-file duplicates of the same entity) and a `tools/validate-build.mjs`-style script that scaffolds them through the real CLI into a throwaway sample project, then actually builds/tests the output with the stack's own toolchain. `scaffold validate-pack` and render-only checks only prove `generate` didn't throw — they never catch a namespace mismatch, a missing `using`, or a wrong method name, all compile errors that only a real build step surfaces. Reference implementation: `packages/templates-dotnet/tools/validate-build.mjs`.
- That build-check must run in CI (see `.github/workflows/ci.yml`'s `templates-dotnet-build-check` job) and gate the `publish` job's `needs:` list — a pack, new or extended, must not reach npm without it passing.
- Extending an existing pack for a new target (e.g. a cloud provider): a config-only swap is a manifest-`options` conditional in the existing templates (see `options.database.provider` in `v8-controller`'s `InfrastructureCsproj.hbs`); a real architectural addition is a new, additive sibling version folder (e.g. `v8-controller-gcp`) with its own descriptor and non-colliding injection marker names, layered on top of the base version at `scaffold init`/`generate` time. Either way it needs its own `test_data` and its own passing build-check — it inherits none from the base version.
