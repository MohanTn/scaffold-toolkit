/**
 * Exercises the built dist/cli.js (mirrors pipeline_worker/test/cli.test.ts):
 * run `npm run build` before `npm test` when touching the CLI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { saveConfig } from '../../src/config/loader.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, UNCATALOGED_PACK_VERSION, writeManifestFile } from './testHarness.js';

interface BootstrapMarkersReportEntry {
  marker: string;
  file?: string;
  packSlot: string;
  reason?: string;
}
interface BootstrapMarkersUnsupportedPackEntry {
  packSlot: string;
  version: string;
  reason: string;
}
interface BootstrapMarkersReportShape {
  dryRun: boolean;
  placed: BootstrapMarkersReportEntry[];
  alreadyPresent: BootstrapMarkersReportEntry[];
  needsManual: BootstrapMarkersReportEntry[];
  unsupportedPacks: BootstrapMarkersUnsupportedPackEntry[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, '..', '..', 'dist', 'cli.js');
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [cliPath, ...args], { cwd, encoding: 'utf8' });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

test('scaffold -v prints the installed package version', () => {
  assert.ok(existsSync(cliPath), `${cliPath} not built — run "npm run build" first`);
  const { stdout, status } = runCli(['-v'], __dirname);
  assert.equal(status, 0);
  assert.match(stdout.trim(), new RegExp(pkg.version.replace(/\./g, '\\.')));
});

test('scaffold init --pack seeds .scaffold/config.json with the given project type and a path-based pack', () => {
  const targetRepo = buildFixtureTargetRepo();
  const { status } = runCli(['init', '--project-type', 'dotnet', '--pack', 'backend=templates/templates-dotnet@v8-controller'], targetRepo);
  assert.equal(status, 0);
  const config = JSON.parse(readFileSync(path.join(targetRepo, '.scaffold', 'config.json'), 'utf8'));
  assert.equal(config.projectType, 'dotnet');
  assert.equal(config.packs.backend.path, 'templates/templates-dotnet');
  assert.equal(config.packs.backend.version, 'v8-controller');
  assert.equal(config.packs.backend.url, undefined);
});

test('scaffold init --pack rejects a git-URL spec with a clear error instead of silently accepting it', () => {
  const targetRepo = buildFixtureTargetRepo();
  const result = runCli(['init', '--project-type', 'dotnet', '--pack', 'backend=https://example.com/pack.git@v1'], targetRepo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no longer accepts a git URL/);
});

// Regression: the git-URL heuristic originally only checked for "://" and a
// "git@" prefix, missing the scp-style shorthand with no explicit user
// (`host:path`, valid via an ssh config Host alias) — this used to exit 0
// and silently write a bogus path entry instead of being rejected.
test('scaffold init --pack rejects the scp-style shorthand "host:path" git remote (no explicit git@ user)', () => {
  const targetRepo = buildFixtureTargetRepo();
  const result = runCli(['init', '--project-type', 'dotnet', '--pack', 'backend=github.com:org/repo.git@v1'], targetRepo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no longer accepts a git URL/);
});

test('scaffold init --pack does not false-positive the scp-style check on a real local path that happens to contain a colon (Windows drive letter, or a relative path with a colon in a segment)', () => {
  const targetRepo = buildFixtureTargetRepo();

  const windowsPath = runCli(['init', '--project-type', 'dotnet', '--pack', 'backend=C:\\templates-dotnet@v1'], targetRepo);
  assert.equal(windowsPath.status, 0, JSON.stringify(windowsPath));
  const configAfterWindows = JSON.parse(readFileSync(path.join(targetRepo, '.scaffold', 'config.json'), 'utf8'));
  assert.equal(configAfterWindows.packs.backend.path, 'C:\\templates-dotnet');

  const relativeWithColon = runCli(['init', '--project-type', 'dotnet', '--pack', 'backend=./foo:bar@v1'], targetRepo);
  assert.equal(relativeWithColon.status, 0, JSON.stringify(relativeWithColon));
  const configAfterRelative = JSON.parse(readFileSync(path.join(targetRepo, '.scaffold', 'config.json'), 'utf8'));
  assert.equal(configAfterRelative.packs.backend.path, './foo:bar');
});

test('scaffold generate then scaffold status end to end through the CLI: non-zero while unfilled, filling resolves it', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  runCli(['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], targetRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  const generateResult = runCli(['generate', '--manifest', manifestFile, '--json'], targetRepo);
  assert.equal(generateResult.status, 0);
  const report = JSON.parse(generateResult.stdout);
  assert.equal(report.created[0].file, 'src/Endpoints/InvoiceEndpoint.cs');

  const statusBefore = runCli(['status', '--json'], targetRepo);
  assert.equal(statusBefore.status, 1);

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  const { writeFileSync } = await import('node:fs');
  writeFileSync(endpointPath, filled);

  const statusAfter = runCli(['status', '--json'], targetRepo);
  assert.equal(statusAfter.status, 0);
});

test('scaffold generate --dry-run --format doc renders a human-readable preflight and writes nothing to disk', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  runCli(['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], targetRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  const result = runCli(['generate', '--manifest', manifestFile, '--dry-run', '--format', 'doc'], targetRepo);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /scaffold generate — preflight \(dry-run, nothing written\)/);
  assert.match(result.stdout, /Entity: Invoice/);
  assert.match(result.stdout, /src\/Endpoints\/InvoiceEndpoint\.cs \(mode: skip-if-exists\)/);
  assert.equal(existsSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs')), false, '--dry-run must still write nothing to disk under --format doc');
});

test('scaffold generate then scaffold next end to end through the CLI: non-zero with a placeholder digest, filling clears it', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  runCli(['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], targetRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  runCli(['generate', '--manifest', manifestFile, '--json'], targetRepo);

  const nextBefore = runCli(['next', '--json'], targetRepo);
  assert.equal(nextBefore.status, 1);
  const digestBefore = JSON.parse(nextBefore.stdout);
  assert.equal(digestBefore.done, false);
  assert.equal(digestBefore.blocks[0].file, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.ok('placeholder' in digestBefore.blocks[0]);

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  const { writeFileSync } = await import('node:fs');
  writeFileSync(endpointPath, filled);

  const nextAfter = runCli(['next', '--json'], targetRepo);
  assert.equal(nextAfter.status, 0);
  const digestAfter = JSON.parse(nextAfter.stdout);
  assert.equal(digestAfter.done, true);
  assert.deepEqual(digestAfter.blocks, []);
});

test('scaffold pack new writes a schema-valid empty descriptor plus a validate-build.mjs stub, and refuses to overwrite an existing one', async () => {
  const targetRepo = buildFixtureTargetRepo();
  const packDir = path.join(targetRepo, 'my-pack');

  const result = runCli(['pack', 'new', '--dir', packDir, '--pack-version', 'v1', '--stack', 'backend'], targetRepo);
  assert.equal(result.status, 0);

  const descriptor = JSON.parse(readFileSync(path.join(packDir, 'v1', 'manifest.templates.json'), 'utf8'));
  assert.equal(descriptor.descriptorSchemaVersion, 2);
  assert.equal(descriptor.packVersion, 'v1');
  assert.deepEqual(descriptor.targets, []);
  assert.deepEqual(descriptor.injections, []);
  assert.deepEqual(descriptor.inputs, []);

  const stub = readFileSync(path.join(packDir, 'tools', 'validate-build.mjs'), 'utf8');
  assert.match(stub, /STUB/);
  assert.match(stub, /backend/);

  // No .hbs templates and no test_data fixtures — the leanest MVP skeleton.
  const versionDirEntries = readdirSync(path.join(packDir, 'v1'));
  assert.deepEqual(versionDirEntries, ['manifest.templates.json']);
  assert.ok(!existsSync(path.join(packDir, 'test_data')));

  const again = runCli(['pack', 'new', '--dir', packDir, '--pack-version', 'v1'], targetRepo);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);
});

test('scaffold pack new\'s empty skeleton passes scaffold validate-pack trivially, against any manifest', async () => {
  const targetRepo = buildFixtureTargetRepo();
  const packDir = path.join(targetRepo, 'my-pack');
  runCli(['pack', 'new', '--dir', packDir, '--pack-version', 'v1'], targetRepo);

  const { writeFileSync } = await import('node:fs');
  const manifestPath = path.join(targetRepo, 'minimal.manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ manifestSchemaVersion: 1, targetStack: 'backend' }));

  const result = runCli(['validate-pack', '--pack', packDir, '--manifest', manifestPath, '--json'], targetRepo);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.allValid, true);
  assert.equal(report.results[0].targetsRendered, 0);
  assert.equal(report.results[0].injectionsExercised, 0);
});

test('scaffold pack new\'s validate-build.mjs stub fails loudly when run, instead of silently "passing" an unimplemented build-check', () => {
  const targetRepo = buildFixtureTargetRepo();
  const packDir = path.join(targetRepo, 'my-pack');
  runCli(['pack', 'new', '--dir', packDir, '--pack-version', 'v1'], targetRepo);

  let status = 0;
  let stderr = '';
  try {
    execFileSync('node', [path.join(packDir, 'tools', 'validate-build.mjs')], { encoding: 'utf8' });
  } catch (error) {
    const err = error as { status?: number; stderr?: string };
    status = err.status ?? 1;
    stderr = err.stderr ?? '';
  }
  assert.notEqual(status, 0);
  assert.match(stderr, /stub/i);
});

test('scaffold status prints a friendly error and exits 1 instead of a raw stack trace when a tracked file is malformed', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  runCli(['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], targetRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  runCli(['generate', '--manifest', manifestFile, '--json'], targetRepo);

  // Hand-corrupt the tracked file with an unbalanced AI_IMPLEMENTATION marker
  // (an END with no matching START) — scanAiImplementationBlocks throws on
  // this, which computeStatus does not catch, so this exercises the CLI's
  // own error-handling wrapper around the status command's action.
  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(endpointPath, readFileSync(endpointPath, 'utf8') + '\n// AI_IMPLEMENTATION_END\n');

  const result = runCli(['status', '--json'], targetRepo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scaffold status failed:/);
  assert.doesNotMatch(result.stderr, /at computeStatus/, 'should print a friendly message, not a raw stack trace');
});

test('scaffold --help lists every command with a short summary plus a typical-flow epilogue', () => {
  const { stdout, status } = runCli(['--help'], __dirname);
  assert.equal(status, 0);
  for (const command of ['init', 'manifest', 'templates', 'generate', 'next', 'undo', 'status', 'bootstrap-markers', 'validate-pack', 'check-edit', 'pack']) {
    assert.match(stdout, new RegExp(`^\\s+${command}`, 'm'), `command "${command}" missing from scaffold --help`);
  }
  // Long descriptions must not leak into the command list — summaries keep it scannable.
  assert.match(stdout, /adopt a brownfield repo into pack ownership/);
  assert.doesNotMatch(stdout, /persisted to \.scaffold\/config\.json's adoptedPaths/);
  assert.match(stdout, /Typical flow:/);
});

test('scaffold generate --help includes usage examples', () => {
  const { stdout, status } = runCli(['generate', '--help'], __dirname);
  assert.equal(status, 0);
  assert.match(stdout, /Examples:/);
  assert.match(stdout, /scaffold generate --manifest invoice\.manifest\.json --dry-run/);
});

test('scaffold with an unknown command exits non-zero and points at --help', () => {
  const result = runCli(['generat'], __dirname);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command/);
  assert.match(result.stderr, /scaffold <command> --help/);
});

test('scaffold bootstrap-markers --help shows --pack-version', () => {
  const { stdout, status } = runCli(['bootstrap-markers', '--help'], __dirname);
  assert.equal(status, 0);
  assert.match(stdout, /--pack-version/);
});

test('scaffold bootstrap-markers with neither a config nor --pack-version prints a friendly error and exits 1, not a stack trace', () => {
  const targetRepo = buildFixtureTargetRepo();
  const result = runCli(['bootstrap-markers'], targetRepo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scaffold bootstrap-markers failed:/);
  assert.match(result.stderr, /scaffold init|--pack-version/);
  assert.doesNotMatch(result.stderr, /at runBootstrapMarkers/, 'should print a friendly message, not a raw stack trace');
});

test('scaffold bootstrap-markers --pack-version v10-minimal-api-gcp --json places markers into a brownfield Program.cs and exits 0', () => {
  const targetRepo = buildFixtureTargetRepo(false);
  const result = runCli(['bootstrap-markers', '--pack-version', 'v10-minimal-api-gcp', '--json'], targetRepo);
  const report = JSON.parse(result.stdout) as BootstrapMarkersReportShape;

  const di = report.placed.find((p) => p.marker === 'DI');
  assert.ok(di, 'expected DI to be placed');
  assert.equal(di!.file, 'Program.cs');
  assert.equal(di!.packSlot, '(--pack-version override)');
  assert.ok(report.needsManual.length > 0, 'DBSETS/REPOSITORIES should be needs-manual since this fixture has no matching files');
  assert.equal(result.status, 1, 'exit code reflects the remaining needs-manual entries');
});

test('scaffold bootstrap-markers exits 0 once every group in the pack has a matching candidate file and nothing is left needs-manual', async () => {
  const targetRepo = buildFixtureTargetRepo(false); // brownfield Program.cs, no markers
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(path.join(targetRepo, 'src', 'Infrastructure', 'Persistence'), { recursive: true });
  mkdirSync(path.join(targetRepo, 'src', 'Application'), { recursive: true });
  writeFileSync(
    path.join(targetRepo, 'src', 'Infrastructure', 'Persistence', 'AppDbContext.cs'),
    'public class AppDbContext : DbContext\n{\n}\n',
  );
  writeFileSync(
    path.join(targetRepo, 'src', 'Application', 'ApplicationServiceCollectionExtensions.cs'),
    'public static class ApplicationServiceCollectionExtensions\n{\n    public static IServiceCollection AddApplication(this IServiceCollection services)\n    {\n        return services;\n    }\n}\n',
  );

  // v8-controller: DI (builder-zone only), DBSETS, REPOSITORIES — every candidate file is present, so nothing should be needs-manual.
  const result = runCli(['bootstrap-markers', '--pack-version', 'v8-controller', '--json'], targetRepo);
  const report = JSON.parse(result.stdout) as BootstrapMarkersReportShape;
  assert.equal(report.needsManual.length, 0, JSON.stringify(report.needsManual));
  assert.ok(report.placed.find((p) => p.marker === 'DI'));
  assert.ok(report.placed.find((p) => p.marker === 'DBSETS'));
  assert.ok(report.placed.find((p) => p.marker === 'REPOSITORIES'));
  assert.equal(result.status, 0);
});

test('scaffold check-edit --tool write allows a plain write in a repo with no .scaffold/config.json', () => {
  const targetRepo = buildFixtureTargetRepo();
  const result = runCli(['check-edit', '--file', 'src/Endpoints/InvoiceEndpoint.cs', '--tool', 'write'], targetRepo);
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.allow, true);
  assert.equal(decision.reason, 'no-config');
});

test('scaffold check-edit --tool write exits 1 and blocks a direct write to a pack-owned, unrendered target path', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  runCli(['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], targetRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));

  const result = runCli(['check-edit', '--file', 'src/Endpoints/InvoiceEndpoint.cs', '--tool', 'write'], targetRepo);
  assert.equal(result.status, 1);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'write-blocked');
});

test('scaffold check-edit --old-string-file reads old_string from a file instead of the command line', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  runCli(['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], targetRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  runCli(['generate', '--manifest', manifestFile, '--json'], targetRepo);

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const { writeFileSync } = await import('node:fs');
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  writeFileSync(endpointPath, filled);

  const oldStringFile = path.join(targetRepo, 'old-string.txt');
  writeFileSync(oldStringFile, 'Console.WriteLine("handled");');

  const result = runCli(
    ['check-edit', '--file', 'src/Endpoints/InvoiceEndpoint.cs', '--tool', 'edit', '--old-string-file', oldStringFile],
    targetRepo,
  );
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.allow, true);
  assert.equal(decision.reason, 'edit-allowed-in-interior');
});

test('scaffold check-edit rejects an unknown --tool value with a friendly error, not a stack trace', () => {
  const targetRepo = buildFixtureTargetRepo();
  const result = runCli(['check-edit', '--file', 'x.cs', '--tool', 'delete'], targetRepo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scaffold check-edit failed:/);
  assert.match(result.stderr, /--tool must be "write" or "edit"/);
});

test('scaffold bootstrap-markers exits 0 for a backend: v8-controller (fully placeable) + frontend: <uncataloged> config — an unsupported pack slot must never block a clean exit', async () => {
  const targetRepo = buildFixtureTargetRepo(false); // brownfield Program.cs, no markers
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(path.join(targetRepo, 'src', 'Infrastructure', 'Persistence'), { recursive: true });
  mkdirSync(path.join(targetRepo, 'src', 'Application'), { recursive: true });
  writeFileSync(path.join(targetRepo, 'src', 'Infrastructure', 'Persistence', 'AppDbContext.cs'), 'public class AppDbContext : DbContext\n{\n}\n');
  writeFileSync(
    path.join(targetRepo, 'src', 'Application', 'ApplicationServiceCollectionExtensions.cs'),
    'public static class ApplicationServiceCollectionExtensions\n{\n    public static IServiceCollection AddApplication(this IServiceCollection services)\n    {\n        return services;\n    }\n}\n',
  );
  saveConfig(targetRepo, {
    projectType: 'dotnet+react',
    packs: {
      backend: { url: 'https://example.com/scaffold-templates-dotnet.git', version: 'v8-controller' },
      frontend: { url: 'https://example.com/scaffold-templates-react.git', version: UNCATALOGED_PACK_VERSION },
    },
  });

  const result = runCli(['bootstrap-markers', '--json'], targetRepo);
  const report = JSON.parse(result.stdout) as BootstrapMarkersReportShape;

  assert.equal(report.needsManual.length, 0, JSON.stringify(report.needsManual));
  assert.ok(report.placed.find((p) => p.marker === 'DI' && p.packSlot === 'backend'));
  assert.ok(report.placed.find((p) => p.marker === 'DBSETS' && p.packSlot === 'backend'));
  assert.ok(report.placed.find((p) => p.marker === 'REPOSITORIES' && p.packSlot === 'backend'));

  const frontendUnsupported = report.unsupportedPacks.find((u) => u.packSlot === 'frontend');
  assert.ok(frontendUnsupported, 'the frontend slot should be reported under unsupportedPacks');
  assert.equal(frontendUnsupported!.version, UNCATALOGED_PACK_VERSION);

  assert.equal(result.status, 0, 'an unsupported pack slot must not block a clean exit once every actionable marker is resolved');
});
