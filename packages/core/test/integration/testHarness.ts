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

export function buildFixtureTargetRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-target-'));
  writeFileSync(path.join(dir, 'Program.cs'), PROGRAM_CS);
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
