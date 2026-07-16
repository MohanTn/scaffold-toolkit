import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { undoChangeset, UndoBlockedError, UndoHashMismatchError } from '../../src/undo/undo.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, writeInitialConfig, writeManifestFile, PROGRAM_CS } from './testHarness.js';

async function setup() {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  return { packRepo, targetRepo };
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

// A fixture pack whose single create target is ALSO an injection target — the
// endpoint file ships its own marker pair, and the same generate run both
// creates it and injects into it (mirroring a controller that registers
// itself via its own marker group). This is the scenario that previously
// produced two ChangeEntry records for one file (create-time hash, then a
// separate post-injection hash), causing `undo` to require --force and then
// leave the file behind.
function buildSelfInjectingFixturePackRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-self-inject-pack-'));
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
        targets: [{ output: 'src/Endpoints/{{entity}}Endpoint.cs', template: 'Endpoint.cs.hbs', mode: 'skip-if-exists' }],
        injections: [
          {
            file: 'src/Endpoints/{{entity}}Endpoint.cs',
            marker: 'REGISTER',
            template: 'register.hbs',
            position: 'before-end',
            hashTrailerPrefix: '// scaffold-hash:',
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(versionDir, 'Endpoint.cs.hbs'),
    `namespace Fixture.Endpoints;

public class {{entity}}Endpoint
{
    public void Handle()
    {
    }

    // SCAFFOLD:REGISTER:START
    // SCAFFOLD:REGISTER:END
}
`,
  );
  writeFileSync(path.join(versionDir, 'register.hbs'), `    // registered {{entity}}`);

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'self-injecting pack']);
  return dir;
}

test('scaffold undo: reverts a generate run to the exact prior state, deleting the created file', async () => {
  const { targetRepo } = await setup();
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.ok(existsSync(endpointPath));

  undoChangeset(targetRepo, report.changesetId!, false);

  assert.equal(existsSync(endpointPath), false, 'created file must be deleted, not left with stale content');
  assert.equal(readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8'), PROGRAM_CS);
});

test('scaffold undo: refuses when the file was hand-edited since generate (hash mismatch), unless --force', async () => {
  const { targetRepo } = await setup();
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const programPath = path.join(targetRepo, 'Program.cs');
  const generatedProgram = readFileSync(programPath, 'utf8');
  writeFileSync(programPath, `${generatedProgram}\n// a human added this line by hand\n`);

  assert.throws(() => undoChangeset(targetRepo, report.changesetId!, false), UndoHashMismatchError);

  // --force discards the hand edit and restores the exact prior state.
  undoChangeset(targetRepo, report.changesetId!, true);
  assert.equal(readFileSync(programPath, 'utf8'), PROGRAM_CS);
});

test('scaffold undo: refuses to undo an earlier changeset once a later changeset touched the same file, naming it', async () => {
  const { targetRepo } = await setup();

  const invoiceManifest = writeManifestFile(targetRepo, 'Invoice');
  const changesetA = await runGenerate({ repoRoot: targetRepo, manifestPath: invoiceManifest, dryRun: false, force: false });

  // Customer's DI/route registrations render different content than Invoice's,
  // so injecting into the already-populated Program.cs markers needs --force
  // (the interior is no longer empty — this simulates two features scaffolded
  // into the same DI block across two separate runs).
  const customerManifest = writeManifestFile(targetRepo, 'Customer');
  const changesetB = await runGenerate({ repoRoot: targetRepo, manifestPath: customerManifest, dryRun: false, force: true });

  assert.throws(() => undoChangeset(targetRepo, changesetA.changesetId!, false), (err: unknown) => {
    assert.ok(err instanceof UndoBlockedError);
    assert.match(err.message, new RegExp(changesetB.changesetId!));
    assert.match(err.message, /Program\.cs/);
    return true;
  });
});

test('scaffold undo: a file created and injected into in the same run undoes without --force and leaves nothing behind', async () => {
  const packRepo = buildSelfInjectingFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));

  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.ok(existsSync(endpointPath));
  assert.match(readFileSync(endpointPath, 'utf8'), /registered Invoice/);

  // Must NOT throw UndoHashMismatchError: the create-phase hash and the
  // post-injection hash must have been merged into a single ChangeEntry.
  undoChangeset(targetRepo, report.changesetId!, false);
  assert.equal(existsSync(endpointPath), false, 'created+injected file must be fully removed, not left with pre-injection content');

  // Re-generate right after must succeed — no leftover create-mode file
  // blocking it with "already exists and its target mode is create".
  const secondManifest = writeManifestFile(targetRepo, 'Invoice');
  await assert.doesNotReject(() => runGenerate({ repoRoot: targetRepo, manifestPath: secondManifest, dryRun: false, force: false }));
});
