/**
 * Exercises the built dist/cli.js (mirrors pipeline_worker/test/cli.test.ts):
 * run `npm run build` before `npm test` when touching the CLI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, writeManifestFile } from './testHarness.js';

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

test('scaffold init --pack seeds .scaffold/config.json with the given project type and pack', () => {
  const targetRepo = buildFixtureTargetRepo();
  const { status } = runCli(['init', '--project-type', 'dotnet', '--pack', 'backend=https://example.com/pack.git@v1'], targetRepo);
  assert.equal(status, 0);
  const config = JSON.parse(readFileSync(path.join(targetRepo, '.scaffold', 'config.json'), 'utf8'));
  assert.equal(config.projectType, 'dotnet');
  assert.equal(config.packs.backend.url, 'https://example.com/pack.git');
  assert.equal(config.packs.backend.version, 'v1');
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
