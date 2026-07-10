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
