# scaffold-templates-dotnet

A versioned Handlebars template pack for the `@mohantn/scaffold-core` CLI, covering
Clean Architecture for ASP.NET Core 8 (classic controllers) and ASP.NET Core 10 (minimal
API), with optional Google Cloud Platform integration (Pub/Sub + Saga pattern + Google
Secret Manager).

| Folder | Stack | Topology |
|---|---|---|
| `v8-controller/`            | ASP.NET Core 8 with classic controllers         | Domain / Application / Infrastructure / Presentation(Controllers + IExceptionFilter) |
| `v10-minimal-api/`          | ASP.NET Core 10 minimal API                     | Domain / Application / Infrastructure / Presentation(Endpoints + ExceptionHandlingMiddleware) |
| `v8-controller-gcp/`        | ASP.NET Core 8 + Google Cloud                  | Additive GCP pack — runs on top of `v8-controller`. Adds Pub/Sub messaging, Saga pattern, Google Secret Manager. |
| `v10-minimal-api-gcp/`      | ASP.NET Core 10 + Google Cloud                  | Additive GCP pack — runs on top of `v10-minimal-api`. Adds the same GCP integration. |

The pack is consumed exclusively by the `scaffold` CLI (`docs/prd.md` is the engine-side
source of truth). The engine clones this repo into its local template cache, reads each
version folder's `manifest.templates.json`, validates it, renders the declared Handlebars
templates with the host-supplied intent manifest, and writes the result to the target repo.
It never calls an LLM itself.

## Scaffold workflow

For a non-GCP project, choose one pack:

```sh
scaffold init --pack v8-controller         # ASP.NET Core 8 + classic controllers
scaffold init --pack v10-minimal-api       # ASP.NET Core 10 + minimal API
scaffold templates sync
scaffold generate --manifest Invoice.toon
```

For a GCP project, scaffold the base pack first, then the matching `*-gcp` pack to add
Pub/Sub, the saga pattern, and Google Secret Manager. The two packs write to disjoint
files and use different Program.cs injection markers (`DI` from the base, `GSM`,
`PUBSUB`, and `SAGAS` from the GCP pack), so they coexist cleanly.

```sh
scaffold init --pack v8-controller
scaffold init --pack v8-controller-gcp     # GCP pack: additive, no clean-arch duplication
scaffold templates sync
scaffold generate --manifest Invoice.toon
```

If you switch stacks later (e.g. `v8-controller` → `v10-minimal-api`), the engine's
provenance check (per the PRD) refuses to inject into files stamped with the prior
pack's identity and asks for a manual marker migration.

## What gets scaffolded (per entity)

For each `{{entity}}` in the intent manifest:

| Layer | Path | Purpose |
|---|---|---|
| Domain        | `src/Domain/Entities/{{entity}}.cs`                          | POCO with Id and the manifest's other fields. |
| Application   | `src/Application/DTOs/{{entity}}Dto.cs`                      | Immutable record exposed over the wire. |
| Application   | `src/Application/Interfaces/I{{entity}}Repository.cs`        | Per-entity repo interface extending `IRepository<T>`. |
| Application   | `src/Application/Interfaces/I{{entity}}Service.cs`           | Application service contract. |
| Application   | `src/Application/Services/{{entity}}Service.cs`              | Service implementation; AI markers wrap business logic. |
| Application   | `src/Application/Messaging/Events/{{entity}}ChangedEvent.cs` *(GCP only)* | Domain event payload. |
| Application   | `src/Application/Messaging/Handlers/{{entity}}EventHandler.cs` *(GCP only)* | Pub/Sub `IMessageHandler<T>` implementation. |
| Application   | `src/Application/Sagas/{{entity}}Saga.cs` *(GCP only)*       | Per-entity saga orchestrator. |
| Infrastructure| `src/Infrastructure/Persistence/Configurations/{{entity}}Configuration.cs` | `IEntityTypeConfiguration<{{entity}}>` mapping column types, required-ness, table name. |
| Infrastructure| `src/Infrastructure/Persistence/Repositories/{{entity}}Repository.cs`      | EF Core repository backed by `AppDbContext`. |
| Presentation  | `src/Presentation/Controllers/{{entity}}Controller.cs` *(v8)*   | MVC controller. |
| Presentation  | `src/Presentation/Endpoints/{{entity}}Endpoint.cs` *(v10)*     | Minimal-API endpoint class with a `Map(this IEndpointRouteBuilder)` extension. |

One-time scaffold targets (`mode: "skip-if-exists"`):

| Path | Purpose |
|---|---|
| `src/Application/Common/IRepository.cs`                                | Generic `IRepository<T>` base. |
| `src/Application/Exceptions/NotFoundException.cs`                      | Domain "not found" → 404. |
| `src/Application/Exceptions/ValidationException.cs`                    | Validation failure → 400. |
| `src/Application/Interfaces/IUnitOfWork.cs`                            | UoW abstraction. |
| `src/Application/ApplicationServiceCollectionExtensions.cs`            | `AddApplication(IServiceCollection)` extension. |
| `src/Application/Messaging/IMessageBus.cs` *(GCP only)*                | Pub/Sub abstraction + handler registry contract. |
| `src/Application/Messaging/IMessageHandler.cs` *(GCP only)*            | Per-entity handler contract. |
| `src/Application/Sagas/ISaga.cs` *(GCP only)*                          | Saga marker interface. |
| `src/Application/Sagas/SagaState.cs` *(GCP only)*                      | Persistent saga state (lives in `AppDbContext`). |
| `src/Application/Sagas/SagaOrchestratorBase.cs` *(GCP only)*           | Abstract base for per-entity orchestrators. |
| `src/Infrastructure/Persistence/AppDbContext.cs`                       | `DbContext` with `DBSETS` marker. |
| `src/Infrastructure/Persistence/UnitOfWork.cs`                          | Scoped `IUnitOfWork` impl. |
| `src/Infrastructure/InfrastructureServiceCollectionExtensions.cs`      | `AddInfrastructure(IServiceCollection, IConfiguration)`. |
| `src/Infrastructure/Gcp/Secrets/GoogleSecretManagerConfigurationExtensions.cs` *(GCP only)* | `IConfigurationBuilder` extension that reads from Google Secret Manager. |
| `src/Infrastructure/Gcp/Messaging/GoogleCloudPubSubOptions.cs` *(GCP only)* | Options bound to the `Gcp:PubSub` config section. |
| `src/Infrastructure/Gcp/Messaging/GoogleCloudPubSubSubscriptionService.cs` *(GCP only)* | `BackgroundService` that owns `SubscriberClient` per configured subscription. |
| `src/Infrastructure/Gcp/Messaging/GoogleCloudPubSubMessageBus.cs` *(GCP only)* | `IMessageBus` implementation; caches one `PublisherClient` per topic id and publishes via Google Cloud Pub/Sub. |
| `src/Infrastructure/Messaging/MessageHandlerRegistry.cs` *(GCP only)* | Reflection-based `IMessageHandlerRegistry` impl. |
| `src/Infrastructure/Messaging/MessageHandlerWarmupService.cs` *(GCP only)* | `IHostedService` that eagerly resolves every `IMessageHandler<T>` at startup so the per-entity handler ctor self-registers in the registry. |
| `src/Infrastructure/Persistence/SagasDbContext.cs` *(GCP only)* | Minimal `DbContext` for saga state, registered separately via the `SAGAS` injection marker. |
| `src/Presentation/Filters/AppExceptionFilter.cs` *(v8 only)*           | `IExceptionFilter` mapping domain exceptions to ProblemDetails. |
| `src/Presentation/Middleware/ExceptionHandlingMiddleware.cs` *(v10 only)* | Equivalent middleware for minimal-API. |

## GCP integration

The `*-gcp` packs (additive) provide:

### 1. Google Secret Manager configuration provider

`GoogleSecretManagerConfigurationExtensions.AddGoogleSecretManager(builder, projectId, secretToConfigKey)`
loads each named secret from GSM once and exposes it as a normal `IConfiguration` value.
The default scaffold maps `database-connection-string` (the GSM secret name) →
`ConnectionStrings:Default` (the `IConfiguration` key the EF Core `AddInfrastructure`
extension already reads from).

```csharp
builder.Configuration.AddGoogleSecretManager(
    builder.Configuration["Gcp:ProjectId"]
        ?? throw new InvalidOperationException("Configuration value 'Gcp:ProjectId' is required."),
    new Dictionary<string, string>
    {
        ["database-connection-string"] = "ConnectionStrings:Default",
    });
```

Authentication is via Application Default Credentials — `SecretManagerServiceClient.Create()`
picks up `GOOGLE_APPLICATION_CREDENTIALS`, GKE Workload Identity, GCE metadata service, or
`gcloud auth application-default login` automatically. The pack does not write any
auth-provisioning code.

### 2. Google Cloud Pub/Sub subscription service

`GoogleCloudPubSubSubscriptionService` is a hosted `BackgroundService` that owns one
`SubscriberClient` per entry in `GoogleCloudPubSubOptions.Subscriptions`. Each entry maps
a logical `handlerType` (e.g. `"InvoiceChanged"`) to a subscription id (e.g.
`"invoice-changed-sub"`). The subscription service:

1. Subscribes to the configured Google Cloud Pub/Sub subscription.
2. For each `PubsubMessage`, resolves an `IMessageHandlerRegistry` from a fresh DI scope.
3. The registry looks up the typed `IMessageHandler<TMessage>` registered for the
   `handlerType`, deserializes the payload, and invokes `HandleAsync(...)`.
4. ACKs the message on success, NACKs on failure (so Google Pub/Sub redelivers).

### 3. Saga pattern

`Application.Sagas.SagaState` is a generic persistent state row stored in the same EF Core
`AppDbContext` as the rest of the clean-arch model. `SagaOrchestratorBase` is the abstract
base; each per-entity `{{entity}}Saga` extends it and the host LLM fills in the
state-machine body between `// SCAFFOLD:AI_IMPLEMENTATION:START/END` markers. The
orchestrator:

- Persists `SagaState` rows via the existing `IUnitOfWork` (transactions for free).
- Publishes commands/events via `IMessageBus` (Google Pub/Sub under the hood).
- Is invoked when a per-entity `{{entity}}EventHandler` decides a saga is needed.

The pattern is **choreographed** (per-entity handlers drive their own sagas from incoming
events) rather than orchestrated-by-orchestrator; this keeps the LLM's context window
small and avoids MassTransit-style boilerplate.

### GCP configuration shape

`appsettings.json` (or environment variables) for a GCP project:

```json
{
  "Gcp": {
    "ProjectId": "acme-billing-prod",
    "PubSub": {
      "Subscriptions": {
        "InvoiceChanged": "invoice-changed-sub",
        "CustomerChanged": "customer-changed-sub"
      }
    }
  }
}
```

The `handlerType` keys (`"InvoiceChanged"`) must match the type id the host LLM chooses
when wiring `{{entity}}EventHandler` into the registry (e.g. publishing a
`{{entity}}ChangedEvent` always uses the same string).

## Folder layout

```
scaffold-templates-dotnet/
  v8-controller/             # 20 .hbs templates
  v10-minimal-api/           # 22 .hbs templates
  v8-controller-gcp/         # 18 .hbs templates (additive)
  v10-minimal-api-gcp/       # 18 .hbs templates (additive)
  tools/render.mjs           # offline smoke-test renderer (single pack)
  tools/validate-all.mjs     # runs render.mjs across every pack (npm test, CI)
  examples/basic-invoice.manifest.json
  docs/prd.md
  LICENSE
  README.md
```

## Descriptor (`manifest.templates.json`) — schema v2

`targets[]` keys: `output`, `template`, `mode` (`create | skip-if-exists | overwrite`).
`injections[]` keys: `file`, `marker`, `template`, `position`, `hashTrailerPrefix`,
`strategy` (`replace | append`; per-entity markers use `append` so each entity's
snippet accumulates in the block instead of replacing the previous entity's).

Distinct markers used across the pack (per-marker hash-trailer makes them provably scoped
to their block even when several share the same file):

| Marker | File | Purpose |
|---|---|---|
| `DI`           | `Program.cs`                                       | One-time. Calls `AddApplication()` + `AddInfrastructure(builder.Configuration)`. |
| `MIDDLEWARE`   | `Program.cs` *(v10 only)*                          | One-time. Registers `ExceptionHandlingMiddleware`. |
| `ROUTES`       | `Program.cs` *(v10 only)*                          | Per entity. Wires the endpoint's `Map(this IEndpointRouteBuilder)` into the pipeline. |
| `DBSETS`       | `src/Infrastructure/Persistence/AppDbContext.cs`   | Per entity. `public DbSet<{{entity}}> {{plural entity}} { get; set; } = null!;` |
| `REPOSITORIES` | `src/Application/ApplicationServiceCollectionExtensions.cs` | Per entity. Two-line DI registration for repo + service. |
| `GSM`          | `Program.cs` *(GCP packs only)*                    | One-time. `builder.Configuration.AddGoogleSecretManager(...)`. |
| `PUBSUB`       | `Program.cs` *(GCP packs only)*                    | One-time. Registers `GoogleCloudPubSubOptions`, `IMessageBus`, `IMessageHandlerRegistry`, and the hosted subscription/warmup services. |
| `SAGAS`        | `Program.cs` *(GCP packs only)*                    | One-time. Registers `SagasDbContext` against its own connection. |

`requires.scaffoldCli` is `">=0.1.0 <1.0.0"`, matching the engine's initial 0.x release
line.

## Marker syntax

For `.cs` files the engine renders marker comments as `// SCAFFOLD:<id>:START/END` with
hash trailers `// scaffold-hash:<hex>`. AI implementation markers use
`// SCAFFOLD:AI_IMPLEMENTATION:START/END` (reserved namespace; not in descriptor
`injections[]`).

The pack places **only the business-logic line** inside AI markers and keeps the response
wiring (`return Ok(...)`, etc.) outside so the generated C# compiles pre-fill. The
engine records the rendered placeholder text into `.scaffold/pending/<changeset-id>.json`
and the `scaffold status` command later compares current content against that
placeholder.

### Required AI blocks

A start marker tagged `// SCAFFOLD:AI_IMPLEMENTATION:START:required` marks a business-logic
seam the host agent must complete: `scaffold status` tracks it (and the adapter hooks block
the turn) until its content changes from the shipped placeholder, even though that
placeholder already compiles. Untagged blocks are optional extension points, tracked only
when they ship empty. In this pack the required seams are the `Service.cs` methods (both base
packs) and the empty GCP `EventHandler`/`Saga`/`SagaOrchestratorBase` stubs; controllers,
endpoints, and the minimal-API route wiring are left optional because their generated
delegation is complete for basic CRUD.

## Helpers convention

Each pack folder contains a `helpers.js` exporting CommonJS:

```js
module.exports = {
  register(handlebars) {
    handlebars.registerHelper('ns', function (options) {
      const root = options.data.root;
      return (root.options && root.options.rootNamespace) || 'MyApp';
    });
  },
};
```

The reference `scaffold-core` engine loads `helpers.js` from each pack folder on
descriptor-load and calls `module.exports.register(Handlebars)`. Helpers are deliberately
restricted to pure string transforms — no I/O, no shell.

Helpers shipped (identical across all four packs):

| Helper | Returns |
|---|---|
| `{{ns}}` | `options.rootNamespace` or `'MyApp'`. |
| `{{route}}` | `options.route` or `/api/<kebab-plural-entity>`. |
| `{{lower s}}` | Lowercase string. |
| `{{camel s}}` | PascalCase → camelCase. |
| `{{pascal s}}` | kebab/snake → PascalCase. |
| `{{kebab s}}` | PascalCase → kebab-case. |
| `{{plural s}}` | Naive English pluralization. |
| `{{default a b}}` | `a` if non-empty, else `b`. |
| `{{eq a b}}` | Strict equality. |
| `{{isNullable t}}` | True when a field type is C#-nullable (ends with `?`); used to skip `.IsRequired()`. |

## Intent manifest contract

| Field | Used as |
|---|---|
| `entity` (PascalCase) | Class name, variable prefix, route default. |
| `fields[]` | Rendered into entity properties, DTO record parameters, EF Core columns. **The `Id` field is required** — manifest authors must always include `{ "name": "Id", "type": "Guid" }`. |
| `fields[].references` | Optional PascalCase entity name this FK field points at (e.g. `{ "name": "UserId", "type": "Guid", "references": "User" }`). Renders a nullable navigation property on the entity plus the EF `HasOne(...).WithMany().HasForeignKey(...)` mapping. Generate the referenced entity first (see `examples/basic-user.manifest.json` + `examples/related-order.manifest.json`). |
| `fields[].onDelete` | Optional EF `DeleteBehavior` for a `references` field (`Cascade` default, or `Restrict`, `SetNull`, `NoAction`). |
| `options.route` | Optional explicit route. |
| `options.rootNamespace` | Optional explicit root namespace. |
| `options.gcp.projectId` *(GCP packs)* | GCP project id (also comes from `Gcp:ProjectId` config). |

Pub/Sub handler-type → subscription-id mapping lives in the `Gcp:PubSub:Subscriptions`
config section (see the GCP configuration shape below), not in the intent manifest.
The manifest stays stack-agnostic; the runtime configuration wires each `{{entity}}EventHandler`
to a concrete Google Cloud Pub/Sub subscription id.

`field.type` is **passed through verbatim** as the C# type name in generated code. The
host adapter (Skill) is responsible for emitting stack-correct types (`Guid`, `int`,
`decimal`, `DateTime`).

## Singleton transaction

`IUnitOfWork` is **scoped** per request (matches the scoped `DbContext`). For
strict-singleton batch processing, replace `AddScoped` → `AddSingleton` in
`InfrastructureServiceCollectionExtensions.cs` and switch the repository to
`IDbContextFactory<AppDbContext>`.

## Local smoke test

After `npm install` from the repo root, validate every pack in one shot:

```sh
npm test
```

This runs `tools/validate-all.mjs`, which discovers every top-level folder containing a
`manifest.templates.json` and renders it via `tools/render.mjs` against
`examples/basic-invoice.manifest.json`, failing if any pack's descriptor or `.hbs`
templates don't compile and render cleanly. The same command runs in CI
(`.github/workflows/validate-templates.yml`) on every push to `main` and every pull
request, across Node 18/20/22.

To smoke-test a single pack directly:

```sh
node tools/render.mjs --pack v8-controller --manifest examples/basic-invoice.manifest.json --out /tmp/out
```

The renderer loads the descriptor, registers helpers, compiles each template, emits every
non-injection target to a regular file under `<out>/`, and emits every injection
template's content to `<out>/_injections/<marker>-<file>.hbs-rendered`. It does not
simulate `mode: "skip-if-exists"` — every run rewrites files.

`render.mjs`/`validate-all.mjs` are render-only and never touch the injector. To smoke-test a
pack through the *real* engine — exercising injection-path resolution, the marker scanner,
and the `requires` check — use scaffold-core's own command against a checkout of this repo:

```sh
scaffold validate-pack --pack . --manifest examples/basic-invoice.manifest.json
```

## Compatibility

| Engine version | Compatible? |
|---|---|
| `0.1.x` | Yes — `requires.scaffoldCli: ">=0.1.0 <1.0.0"` matches. |

## License

MIT — see `LICENSE`.

## See also

- `docs/prd.md` — the engine-side PRD that defines the descriptor schema, marker
  comments, AI implementation flow, and undo semantics this pack conforms to.
