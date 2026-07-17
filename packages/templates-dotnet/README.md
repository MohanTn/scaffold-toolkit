# scaffold-templates-dotnet

A versioned Handlebars template pack for the `@mohantn/scaffold-core` CLI.

| Folder | Stack | Topology |
|---|---|---|
| `v9-enterprise/` | ASP.NET Core 8, single project, `scaffold add` family | One web project with layer folders (`Domain/`, `Application/`, `Infrastructure/`, `Api/`) + one xunit test project; artifact-scoped (CRUD ops, custom endpoints, domain events, factories, helpers, cloud providers, scheduler jobs, health checks, outbox). See `v9-enterprise/README.md` for the full artifact-tag and marker-zone tables. |

The pack is consumed by the `scaffold` CLI as a local directory (`scaffold init --pack backend=<path-to-this-dir>@v9-enterprise`), read straight off disk. The engine reads the version folder's `manifest.templates.json`, validates it, renders the declared Handlebars templates with the intent manifest a `scaffold add` command compiles, and writes the result to the target repo. It never calls an LLM itself.

## Scaffold workflow

```sh
scaffold init --pack backend=packages/templates-dotnet@v9-enterprise
scaffold add feature --name Product --properties "Name:string,Price:decimal"
scaffold add custom --name GetActiveProducts --return-type int --target-controller ProductsController
scaffold next
```

## Checks

- `tools/validate-build-v9.mjs` — drives the real `scaffold add` commands into throwaway projects, then `dotnet restore/build/test`: the full enterprise sample, the combined repository layout, each cloud provider (real SDKs), and a raw-manifest postgres variant.
- `tools/check-guardrails-v9.mjs` — proves the edit-surface contract with `scaffold check-edit`: injected wiring frozen, AI_IMPLEMENTATION seams editable.

Both run in CI (`.github/workflows/ci.yml`) and gate the npm publish.

Fixtures live in `test_data/v9/` — one manifest per distinct scenario, consumed by `scaffold validate-pack` and hand-testing.
