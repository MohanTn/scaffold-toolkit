# templates-node

A versioned Handlebars template pack for the `@mohantn/scaffold-core` CLI that scaffolds
generic Node.js TypeScript feature modules. Unlike `templates-dotnet`, this pack has no
standalone repo — this in-repo copy is its only source.

| Folder | Stack | Topology |
|---|---|---|
| `generic-v1/` | Node.js + TypeScript (ESM, strict) | One folder per feature module under `src/features/`, with a shared export registry |

The pack is consumed as a local directory (`scaffold init --project-type node --pack module=<repo-root>@packages/templates-node/generic-v1`),
read straight off disk — no git clone, no cache.

## What gets scaffolded

One-time project files (`skip-if-exists`):

| Path | Purpose |
|---|---|
| `package.json` | Minimal Node.js TypeScript project manifest |
| `tsconfig.json` | ESM + strict-mode TypeScript configuration |
| `src/features/index.ts` | Module registry with a `REGISTRY` injection marker |

Per module `{{name}}` in the intent manifest (`create`):

| Path | Purpose |
|---|---|
| `src/features/{{name}}/{{name}}.ts` | Module implementation; AI markers wrap the business logic |
| `src/features/{{name}}/{{name}}.test.ts` | Module unit test |

Each generate also injects an export line for the module into `src/features/index.ts`
via the `REGISTRY` marker.

## Validation

`test_data/` holds one intent manifest per distinct scenario. `tools/validate-build.mjs`
scaffolds all of them through the real CLI into a throwaway sample project (plus a
negative case that must be rejected), then runs the generated project's own toolchain —
`npm run build` (tsc) and `npm test`, with dependencies symlinked from the repo root's
`node_modules` — the only check that catches errors a render-only pass cannot.

From the repo root:

```sh
npm run validate:templates-node        # full build-check against test_data/
npm run check:guardrails:templates-node
```

CI runs the same check as the `templates-node-build-check` job, which gates the
`publish` job.
