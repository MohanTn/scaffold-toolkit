# v8-controller-storemedia-v2

A brownfield-region template pack for the **store-media-api** monolith's V2
clean-architecture CQRS area (`src/StoreMediaApi/V2`). Unlike `v8-controller`
(a greenfield 4-project solution), every target lands **inside the existing
single project** via `pathConfig`, and the two host files it injects into
(`StoreMediaDbContext`, the V2 DI registration) are **adopted** with
`scaffold bootstrap-markers`. Marker names are `_V2`-suffixed so they never
collide with `v8-controller`'s `DI`/`DBSETS`/`REPOSITORIES`.

Per new entity it generates: domain entity, DTO, `I{E}Repository` + repository,
EF configuration, Create/Update/Delete commands (+ handlers, + Create/Update
validators), GetById/GetList queries (+ handlers), a Broker-driven controller,
and a Create handler test — plus injected `DbSet` and repository DI
registrations. Business-logic seams are `// SCAFFOLD:AI_IMPLEMENTATION` blocks.

## Contracts assumed (reconcile with the real repo)

The templates target the store-media-api V2 conventions, stubbed by the
synthetic host harness under `tools/harness/`:

- `StoreMediaApi.MediatR`: `ICommand<T>` / `IQuery<T>` / `ICommandHandler<,>`
  (`HandleAsync`) / `IQueryHandler<,>` / `IBroker` (`SendAsync`)
- `StoreMediaApi.V2.Infrastructure.UnitOfWork.IUnitOfWork` (`SaveChangesAsync`)
- `StoreMediaApi.V2.Infrastructure.Repositories.IRepository<T>`
- `StoreMediaApi.Data.StoreMediaDbContext`
- `StoreMediaApi.V2.V2ServiceRegistration.AddV2Services(this IServiceCollection)`

If the real repo's signatures differ (namespaces, method names, PK type), edit
the `.hbs` bodies and the harness together, then re-run the build-check.

## Wiring it into store-media-api

From the repo root:

```bash
# 1. Configure the pack (local path pack; adjust the toolkit path)
scaffold init --project-type dotnet \
  --pack backend=<path-to>/packages/templates-dotnet@v8-controller-storemedia-v2

# 2. Persist the layout ONCE in .scaffold/config.json's "backend" pack slot.
#    init/bootstrap-markers READ these but do not author them, and the
#    descriptor's own pathConfig block is documentation only — the engine reads
#    pathConfig from the manifest or this config slot. Add:
#      "companyProjectName": "StoreMediaApi",
#      "pathConfig": { ...the full map from manifest.templates.json... }

# 3. Adopt the two host files (stamps the marker pairs, records adoptedPaths)
scaffold bootstrap-markers --dry-run   # review, then run without --dry-run

# 4. Per entity — same loop as greenfield
scaffold manifest new --stack backend --entity Foo --field Name:string --out foo.toon
scaffold generate --manifest foo.toon
# then fill the AI_IMPLEMENTATION blocks (`scaffold next` lists them)
```

## Build-check

```bash
npm run validate:templates-dotnet-storemedia-v2
```

Scaffolds every `test_data/` fixture into a copy of `tools/harness/`, then runs
real `dotnet build` + `dotnet test`. Wired into CI's `templates-dotnet-build-check`
job, which gates `publish`.
