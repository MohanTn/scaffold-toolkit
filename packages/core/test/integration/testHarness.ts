/**
 * Shared fixture builders for the integration tests: a throwaway target
 * repo (a plain directory, not itself a git repo — scaffold doesn't require
 * the target to be a git repo) plus a throwaway template-pack git repo,
 * built via mkdtempSync + `git init`, mirroring pipeline_worker/test/'s
 * real-fixture style. Not itself a *.test.ts file, so the test runner's
 * `test/**\/*.test.ts` glob never picks it up as a suite.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveConfig } from '../../src/config/loader.js';
import type { PackConfig } from '../../src/config/schema.js';

export const PROGRAM_CS = `namespace Fixture;

public static class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        // SCAFFOLD:SCAFFOLD_DI:START
        // SCAFFOLD:SCAFFOLD_DI:END

        var app = builder.Build();

        // SCAFFOLD:SCAFFOLD_ROUTES:START
        // SCAFFOLD:SCAFFOLD_ROUTES:END

        app.Run();
    }
}
`;

// The AI_IMPLEMENTATION block is left literally blank — pack authors leave it
// empty for the host agent to fill in, so the report's "empty" flag (whether
// a host agent still needs to fill this block) stays a literal blank-content
// check rather than needing to distinguish placeholder prose from real code.
const ENDPOINT_TEMPLATE = `namespace Fixture.Endpoints;

public class {{entity}}Endpoint
{
    public void Handle()
    {
        // AI_IMPLEMENTATION_START

        // AI_IMPLEMENTATION_END
    }
}
`;

const DI_TEMPLATE = `        services.AddScoped<I{{entity}}Service, {{entity}}Service>();`;
const ROUTE_TEMPLATE = `        app.MapGet("{{options.route}}", () => Results.Ok());`;

export function fixtureDescriptor(mode: 'create' | 'skip-if-exists' | 'overwrite' = 'skip-if-exists') {
  return {
    descriptorSchemaVersion: 2 as const,
    packVersion: 'v1',
    requires: { scaffoldCli: '>=0.0.0' },
    targets: [{ output: 'src/Endpoints/{{entity}}Endpoint.cs', template: 'Endpoint.cs.hbs', mode }],
    injections: [
      { file: 'Program.cs', marker: 'SCAFFOLD_DI', template: 'di-registration.hbs', position: 'before-end' as const, hashTrailerPrefix: '// scaffold-hash:' },
      { file: 'Program.cs', marker: 'SCAFFOLD_ROUTES', template: 'route-registration.hbs', position: 'before-end' as const, hashTrailerPrefix: '// scaffold-hash:' },
    ],
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Builds a real throwaway git repo for a template pack, with one version
 * folder ("v1") holding the fixture descriptor + Handlebars templates.
 * `extraVersions` adds sibling version folders (same templates, distinct
 * `packVersion` in their descriptor) in that *same* initial commit — used by
 * the provenance test that needs two version folders reachable at one pinned
 * SHA, so switching `.scaffold/config.json`'s configured version is the only
 * thing that changes between two `generate` runs.
 */
export function buildFixturePackRepo(mode: 'create' | 'skip-if-exists' | 'overwrite' = 'skip-if-exists', extraVersions: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-pack-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Scaffold Test']);

  for (const version of ['v1', ...extraVersions]) {
    const versionDir = path.join(dir, version);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(path.join(versionDir, 'manifest.templates.json'), JSON.stringify({ ...fixtureDescriptor(mode), packVersion: version }, null, 2));
    writeFileSync(path.join(versionDir, 'Endpoint.cs.hbs'), ENDPOINT_TEMPLATE);
    writeFileSync(path.join(versionDir, 'di-registration.hbs'), DI_TEMPLATE);
    writeFileSync(path.join(versionDir, 'route-registration.hbs'), ROUTE_TEMPLATE);
  }

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial pack']);
  return dir;
}

/** Commits a trivial change so the pack repo's HEAD sha moves — used by the provenance "pinned SHA moved" test. */
export function advancePackRepo(packRepo: string): void {
  writeFileSync(path.join(packRepo, 'CHANGELOG.md'), `advanced at ${Date.now()}\n`);
  git(packRepo, ['add', '-A']);
  git(packRepo, ['commit', '-q', '-m', 'advance']);
}

export function buildFixtureTargetRepo(withMarkers = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-target-'));
  writeFileSync(path.join(dir, 'Program.cs'), withMarkers ? PROGRAM_CS : BROWNFIELD_PROGRAM_CS);
  return dir;
}

// A brownfield Program.cs: the CreateBuilder/Build/Run structure any minimal
// hosting-model .NET app has, but no SCAFFOLD marker comments yet — the
// starting point bootstrap-markers is meant to operate on.
export const BROWNFIELD_PROGRAM_CS = `namespace Fixture;

public static class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        var app = builder.Build();

        app.Run();
    }
}
`;

/** A real, committed git working tree containing the brownfield Program.cs — used by bootstrap-markers' git-safety tests. */
export function buildGitFixtureTargetRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-git-target-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Scaffold Test']);
  writeFileSync(path.join(dir, 'Program.cs'), BROWNFIELD_PROGRAM_CS);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial brownfield']);
  return dir;
}

// A brownfield AppDbContext.cs matching the real pack's shape closely enough
// for the after-class-brace anchor's declaration pattern to match exactly
// once, with an unambiguous opening brace within the lookahead.
export const BROWNFIELD_APP_DB_CONTEXT_CS = `namespace Fixture.Infrastructure.Persistence;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options)
    {
    }
}
`;

// Two "class AppDbContext" declarations — makes the after-class-brace
// anchor's declaration-pattern search ambiguous (matches twice), exercising
// the needs-manual fallback rather than guessing between candidates.
export const AMBIGUOUS_APP_DB_CONTEXT_CS = `namespace Fixture.Infrastructure.Persistence;

public class AppDbContext : DbContext
{
}

public class AppDbContext : OtherDbContext
{
}
`;

// A brownfield ApplicationServiceCollectionExtensions.cs matching the real
// pack's AddApplication(this IServiceCollection services) signature exactly.
export const BROWNFIELD_APPLICATION_SERVICE_COLLECTION_EXTENSIONS_CS = `namespace Fixture.Application;

public static class ApplicationServiceCollectionExtensions
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        return services;
    }
}
`;

const REAL_MARKER_DI_TEMPLATE = `        services.AddApplication();
        services.AddInfrastructure(builder.Configuration);`;
const REAL_MARKER_ROUTE_TEMPLATE = `        app.Map{{entity}}Endpoints();`;

/**
 * A small, network-free fixture pack (mirroring buildFixturePackRepo) that
 * declares injections[] for the real pack's DI/ROUTES marker names, distinct
 * from the pre-existing synthetic SCAFFOLD_DI/SCAFFOLD_ROUTES fixture used
 * by generate's own unrelated tests. Proves a real `scaffold generate` run
 * injects cleanly into a bootstrap-placed marker using the real pack's
 * naming — the key bootstrap-markers/generate compatibility proof.
 */
export function buildRealMarkerFixturePackRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-real-marker-pack-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Scaffold Test']);

  const versionDir = path.join(dir, 'v10-minimal-api-gcp');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify(
      {
        descriptorSchemaVersion: 2,
        packVersion: 'v10-minimal-api-gcp',
        requires: { scaffoldCli: '>=0.0.0' },
        targets: [],
        injections: [
          { file: 'Program.cs', marker: 'DI', template: 'di-registration.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' },
          { file: 'Program.cs', marker: 'ROUTES', template: 'route-registration.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(versionDir, 'di-registration.hbs'), REAL_MARKER_DI_TEMPLATE);
  writeFileSync(path.join(versionDir, 'route-registration.hbs'), REAL_MARKER_ROUTE_TEMPLATE);

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'real-marker pack']);
  return dir;
}

// An endpoint template whose AI block is tagged :required and ships a
// compilable default (non-empty). It must still be tracked by status — the
// business-logic seam the host agent has to complete — until its content
// changes, which the empty-only tracking rule would have missed.
const REQUIRED_BLOCK_ENDPOINT_TEMPLATE = `namespace Fixture.Endpoints;

public class {{entity}}Endpoint
{
    public void Handle()
    {
        // SCAFFOLD:AI_IMPLEMENTATION:START:required
        var result = _service.Get();
        // SCAFFOLD:AI_IMPLEMENTATION:END
    }
}
`;

/** A fixture pack whose single create target ships a required, non-empty AI block (see REQUIRED_BLOCK_ENDPOINT_TEMPLATE). */
export function buildRequiredBlockFixturePackRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-required-pack-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Scaffold Test']);

  const versionDir = path.join(dir, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify(
      {
        descriptorSchemaVersion: 2,
        packVersion: 'v1',
        requires: { scaffoldCli: '>=0.0.0' },
        targets: [{ output: 'src/Endpoints/{{entity}}Endpoint.cs', template: 'Endpoint.cs.hbs', mode: 'create' }],
        injections: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(versionDir, 'Endpoint.cs.hbs'), REQUIRED_BLOCK_ENDPOINT_TEMPLATE);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'required-block pack']);
  return dir;
}

// A pack version with no ANCHOR_CATALOG entry (e.g. a frontend pack version) — used by bootstrap-markers' honest-empty-slot test.
export const UNCATALOGED_PACK_VERSION = 'tanstack-query';

/**
 * A throwaway Python pack exercising all three new optional descriptor
 * fields (`inputs[]`, `commentSyntax` for `.py`, `bootstrapAnchors`).
 * `aggregate` + `events[]` are the inputs (no `entity`/`fields`); templates
 * use the declared `.py` pack-level commentSyntax map; bootstrap anchors
 * declare an after-line REGISTRY group on app.py and an after-class-brace
 * REPOSITORY group on models.py. Used by the validate-pack
 * "non-dotnet architecture end-to-end" integration test.
 */
export function buildPackDrivenPythonPackRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-python-pack-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Scaffold Test']);

  const versionDir = path.join(dir, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify(
      {
        descriptorSchemaVersion: 2,
        packVersion: 'v1',
        requires: { scaffoldCli: '>=0.0.0' },
        inputs: [
          { name: 'aggregate', type: 'string', required: true, pattern: '^[A-Z][A-Za-z0-9]+$' },
          { name: 'events', type: 'array', required: true, minItems: 1 },
        ],
        commentSyntax: { '.py': { prefix: '# py-pack:' } },
        bootstrapAnchors: [
          { candidateFilenames: ['app.py'], anchor: { kind: 'after-line', pattern: '\\bdef\\s+main\\(' }, markers: ['REGISTRY'] },
          { candidateFilenames: ['models.py'], anchor: { kind: 'after-class-brace', declarationPattern: '\\bclass\\s+Order\\b' }, markers: ['REPOSITORY'] },
        ],
        targets: [
          { output: 'src/aggregates/{{aggregate}}.py', template: 'Aggregate.py.hbs', mode: 'create' },
        ],
        injections: [
          { file: 'app.py', marker: 'REGISTRY', template: 'registry.py.hbs', position: 'before-end', hashTrailerPrefix: '# py-pack-hash:' },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(versionDir, 'Aggregate.py.hbs'), `class {{aggregate}}: pass\n`);
  writeFileSync(path.join(versionDir, 'registry.py.hbs'), `    register_event("{{aggregate}}.{{events.[0].name}}")\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'python pack-driven fixture']);
  return dir;
}

export function writeInitialConfig(targetRepo: string, packUrl: string, pack: Partial<PackConfig> = {}): void {
  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { url: packUrl, version: 'v1', ...pack } } });
}

export function writeManifestFile(targetRepo: string, entity: string, targetStack = 'backend'): string {
  const manifest = {
    manifestSchemaVersion: 1,
    targetStack,
    entity,
    fields: [
      { name: 'id', type: 'guid' },
      { name: 'amount', type: 'decimal' },
    ],
    options: { route: `/api/${entity.toLowerCase()}s` },
  };
  const file = path.join(targetRepo, `${entity}.manifest.json`);
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}
