# scaffold-templates-react

A versioned Handlebars template pack for the `@mohantn/scaffold-core` CLI.

| Folder | Stack | Topology |
|---|---|---|
| `react-app/` | Vite + React 18, plain JS/JSX, `scaffold add` family | One SPA project (`src/components`, `src/hooks`, `src/pages`, `src/context`, `src/api`) plus Vitest + React Testing Library; artifact-scoped, component-level (component, hook, page, context, api-client). See `react-app/README.md` for the full artifact-tag and marker-zone tables. |

The pack is consumed by the `scaffold` CLI as a local directory (`scaffold init --pack frontend=<path-to-this-dir>@react-app`), read straight off disk. The engine reads the version folder's `manifest.templates.json`, validates it, renders the declared Handlebars templates with the intent manifest a `scaffold add` command compiles, and writes the result to the target repo. It never calls an LLM itself.

This pack scaffolds a **React frontend only** — it assumes an existing or generic REST API and does not generate a backend. It is not entity/CRUD-driven the way `csharp-enterprise` is: each artifact kind (component, hook, page, context, api-client) is added one at a time by name, independent of any "entity" concept.

## Scaffold workflow

```sh
scaffold init --project-type js-family --pack frontend=templates/templates-react@react-app
scaffold add component --name Button
scaffold add hook --name UseToggle
scaffold add page --name ProductsPage
scaffold add context --name Auth
scaffold add api-client --name Products
scaffold next
```

## Checks

- `tools/validate-build-react-app.mjs` — drives the real `scaffold add` commands into a throwaway project, then `npm install`/`npm run build`/`npm test`/`npm run lint`.
- `tools/check-guardrails-react-app.mjs` — proves the edit-surface contract with `scaffold check-edit`: injected barrel exports frozen, AI_IMPLEMENTATION seams editable.

Both run in CI (`.github/workflows/ci.yml`) and gate the npm publish.

Fixtures live in `test_data/react-app/`, one manifest per distinct scenario, consumed by `scaffold validate-pack` and hand-testing.
