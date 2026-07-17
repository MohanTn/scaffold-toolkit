# v9-enterprise — single-project enterprise pack

ASP.NET Core 8, one web project with layer folders (`Domain/`, `Application/`, `Infrastructure/`, `Api/`) plus one xunit test project. Built for the `scaffold add` command family: every artifact kind is an opt-in tag, rendered one at a time into the same project.

This pack is **artifact-scoped by design**: its descriptor declares `artifacts` as a required manifest input, so a manifest must always say which artifact tags to render. `scaffold add` compiles that automatically; hand-written manifests pass `--artifact` to `scaffold manifest new`.

## Artifact tags

| Tag | `scaffold add` command | Renders | Injects |
|---|---|---|---|
| `base` (untagged) | part of `add feature` | solution, csproj, Program.cs, shared infra, entity, DTO, EF config, repository, controller | `DI` (Program.cs), `DBSETS` (ApplicationDbContext.cs), `REPOSITORIES` (Infrastructure/DependencyInjection.cs) |
| `op-create` / `op-read` / `op-update` / `op-delete` | `add feature --operations` | command/query + handler (+ validator) + tests per operation | — |
| `custom-endpoint` | `add custom` | Query/Command + handler, partial-class repository method file | `CONTROLLER_ACTIONS` (the target controller), `REPO_INTERFACE_METHODS` (repository interface — split or combined file) |
| `domain-event` | `add domain-event` | INotification record + handler | — |
| `factory` | `add factory` | domain factory | `SERVICES` |
| `helper-guard` / `helper-crypto` | `add helper` | Guard / CryptoHelper (skip-if-exists) | — |
| `cloud-provider` | `add cloud-provider --provider aws\|azure\|gcp` | ICloudStorageProvider + the chosen provider impl (real SDK) | `SERVICES`, `INFRA_PACKAGES` (csproj, XML comment markers) |
| `scheduler-job` | `add scheduler-job` | CronJobService base (BCL BackgroundService) + the job class | `SERVICES` |
| `health-check` | `add health-check` | IHealthCheck class | `HEALTH_CHECKS` (Program.cs) |
| `outbox` | `add outbox-processor` | OutboxMessage entity + EF config + OutboxProcessor | `DBSETS`, `SERVICES` |

## Conventions this pack guarantees

- **Implicit `Id`**: every entity gets `public Guid Id`; manifest `fields` are business fields only (an explicit `Id` field is deduplicated). DTOs are positional records with `Id` first.
- **Combined repository layout** (`options.combine: true`, `add … --combine`): interface and implementation in ONE file with two namespace blocks, so every reference is identical to the split layout. `custom-endpoint` injects the method signature into whichever file carries the `REPO_INTERFACE_METHODS` zone.
- **Custom endpoint wiring is append-only**: the injected controller action and interface signature are frozen wiring; the method's business logic lives in a create-mode partial-class file (`{Entity}Repository.{Method}.cs`) whose AI_IMPLEMENTATION block is the editable seam. This keeps append-strategy injections hash-stable after the agent fills the seam.
- **Operation coherence**: `options.ops.*` (what the controller renders) must match the `op-*` artifact tags (which classes exist). `scaffold add feature` guarantees this; hand-written manifests selecting a subset of `op-*` tags must set `options.ops` to match, or the controller will reference missing handlers.
- **Scheduler jobs are BCL-only** (BackgroundService + PeriodicTimer, interval at `Jobs:{JobName}:IntervalSeconds`); `--scheduler quartz|hangfire` is recorded in `options.scheduler` for a future config-only adapter swap.
- **Database provider**: `options.database.provider` `postgres` swaps Sqlite → Npgsql in the csproj and DbContext registration (config-only conditional, same as v8).

## Build check

`packages/templates-dotnet/tools/validate-build-v9.mjs` drives the real `scaffold add` commands into throwaway projects and runs `dotnet build`/`dotnet test`: the full enterprise sample, the combined layout, each cloud provider, and a raw-manifest postgres variant. It runs in CI and gates publish.
