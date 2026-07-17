import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePack } from '../../src/validatePack/validatePack.js';
import { buildFixturePackRepo, writeManifestFile, buildFixtureTargetRepo, buildPackDrivenPythonPackRepo } from './testHarness.js';

function writeManifest(dir: string): string {
  return writeManifestFile(dir, 'Invoice');
}

test('validate-pack: a coherent fixture pack passes, synthesizing the host-provided Program.cs and exercising both injections', async () => {
  const packRepo = buildFixturePackRepo('create');
  // The manifest just needs to live somewhere on disk; use a throwaway dir.
  const scratch = buildFixtureTargetRepo();
  const manifestPath = writeManifest(scratch);

  const results = await validatePack({ packDir: packRepo, version: 'v1', manifestPath });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].error);
  assert.equal(results[0].injectionsExercised, 2, 'both SCAFFOLD_DI and SCAFFOLD_ROUTES must land');
  assert.deepEqual(results[0].synthesizedFiles, ['Program.cs'], 'the host-provided Program.cs is synthesized, the created Endpoint is not');
});

test('validate-pack: a pack whose injection targets a file it neither creates nor can be synthesized still surfaces the failure through generate, not a crash', async () => {
  // Point an injection at a file with an extension the comment-syntax table
  // does not cover and no override — resolveMarkerSyntax throws, which
  // synthesizeInjectionTarget surfaces as an ok:false result rather than an
  // uncaught exception.
  const packRepo = mkdtempSync(path.join(tmpdir(), 'scaffold-bad-pack-'));
  execFileSync('git', ['init', '-q'], { cwd: packRepo });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: packRepo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: packRepo });
  const versionDir = path.join(packRepo, 'v1');
  execFileSync('mkdir', ['-p', versionDir]);
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify({
      descriptorSchemaVersion: 2,
      packVersion: 'v1',
      requires: { scaffoldCli: '>=0.0.0' },
      targets: [],
      injections: [{ file: 'config.unknownext', marker: 'THING', template: 'thing.hbs', position: 'before-end', hashTrailerPrefix: '# hash:' }],
    }),
  );
  writeFileSync(path.join(versionDir, 'thing.hbs'), 'value = 1');
  execFileSync('git', ['add', '-A'], { cwd: packRepo });
  execFileSync('git', ['commit', '-q', '-m', 'bad pack'], { cwd: packRepo });

  const scratch = buildFixtureTargetRepo();
  const manifestPath = writeManifest(scratch);

  const results = await validatePack({ packDir: packRepo, version: 'v1', manifestPath });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? '', /unknownext|comment syntax/i);
});

test('validate-pack: discovers every version folder when no version is given', async () => {
  const packRepo = buildFixturePackRepo('create', ['v2', 'v3']);
  const scratch = buildFixtureTargetRepo();
  const manifestPath = writeManifest(scratch);

  const results = await validatePack({ packDir: packRepo, manifestPath });
  const versions = results.map((r) => r.version).sort();
  assert.deepEqual(versions, ['v1', 'v2', 'v3']);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
});

// --- Axis 1+2+3 end-to-end: a non-dotnet pack exercising all three new optional descriptor fields ---
// inputs[] declares an `aggregate` + `events[]` vocabulary (no `entity`/`fields`); the pack's
// commentSyntax map covers `.py` (a built-in-TABLE-unlisted extension); bootstrapAnchors declares
// brownfield anchors for both app.py and models.py. validatePackVersion must drive all the way
// through — end-to-end — meaning all three axes compose cleanly.

test('validate-pack: a non-dotnet pack with inputs[] + pack commentSyntax + bootstrapAnchors passes end-to-end', async () => {
  const packRepo = buildPackDrivenPythonPackRepo();
  // The manifest just needs a place on disk; validate-pack synthesizes
  // its own throwaway target repo, so we only need a scratch location
  // for the manifest file itself.
  const manifestDir = mkdtempSync(path.join(tmpdir(), 'scaffold-python-manifest-'));
  const manifestPath = path.join(manifestDir, 'order-placed.manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    manifestSchemaVersion: 1,
    targetStack: 'python-events',
    aggregate: 'OrderPlaced',
    events: [{ name: 'Created', type: 'Guid' }],
  }));
  const results = await validatePack({ packDir: packRepo, version: 'v1', manifestPath });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].error);
  // The Python pack's app.py injection target must be synthesized (the
  // pack's `targets[]` only creates `src/aggregates/{{aggregate}}.py`,
  // not app.py).
  assert.ok(results[0].synthesizedFiles.includes('app.py'), `expected app.py to be synthesized, got: ${results[0].synthesizedFiles.join(', ')}`);
  assert.ok(results[0].injectionsExercised >= 1);
});

test('validate-pack: existing dotnet v1 fixture still passes unchanged under the relaxed manifest schema and new fields', async () => {
  // The legacy default contract (PascalCase entity + non-empty fields) still applies for any
  // descriptor without an `inputs[]` declaration — the dotnet fixtures are unchanged at the
  // descriptor level. This guards against accidental regressions of the relaxed base schema.
  const packRepo = buildFixturePackRepo('create');
  const scratch = buildFixtureTargetRepo();
  const manifestPath = writeManifest(scratch);

  const results = await validatePack({ packDir: packRepo, version: 'v1', manifestPath });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].error);
  assert.equal(results[0].injectionsExercised, 2);
});

// Regression: a relative --pack path used to get written into validate-pack's
// synthesized .scaffold/config.json verbatim, then resolved by generate.ts
// relative to that synthesized target repo (an unrelated mkdtempSync tmp
// dir) instead of the real process cwd the caller ran validate-pack from.
// Every fixture above happens to pass an already-absolute mkdtempSync path,
// which is exactly why this never surfaced.
test('validate-pack: a relative --pack path resolves against the real process cwd, not the synthesized target repo', async () => {
  const packRepo = buildFixturePackRepo('create');
  const scratch = buildFixtureTargetRepo();
  const manifestPath = writeManifest(scratch);

  const relativePackDir = path.relative(process.cwd(), packRepo);
  const results = await validatePack({ packDir: relativePackDir, version: 'v1', manifestPath });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].error);
  assert.equal(results[0].injectionsExercised, 2);
});

test('validate-pack CLI: --pack . run from inside the pack directory itself resolves correctly (the exact invocation templates/templates-dotnet/README.md documents)', () => {
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');
  assert.ok(existsSync(cliPath), `${cliPath} not built — run "npm run build" first`);

  const packRepo = buildFixturePackRepo('create');
  const manifestPath = writeManifest(buildFixtureTargetRepo());

  const stdout = execFileSync(
    'node',
    [cliPath, 'validate-pack', '--pack', '.', '--pack-version', 'v1', '--manifest', manifestPath, '--json'],
    { cwd: packRepo, encoding: 'utf8' },
  );
  const report = JSON.parse(stdout) as { allValid: boolean; results: { ok: boolean; error?: string }[] };
  assert.equal(report.allValid, true, JSON.stringify(report));
  assert.equal(report.results[0].ok, true, report.results[0].error);
});
