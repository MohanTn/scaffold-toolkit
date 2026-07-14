#!/usr/bin/env node
/**
 * tools/validate-build.mjs (v8-controller-storemedia-v2)
 *
 * The compile-level check for the store-media-api V2 region pack. render-only
 * and validate-pack checks stop at "generate didn't throw"; the bugs that
 * matter here (namespace mismatches, wrong Broker/handler signatures, missing
 * DbSet/DI injection) are C# errors only `dotnet build`/`dotnet test` surface.
 *
 * Because this pack generates *fragments* of an existing host (not a
 * standalone solution), it scaffolds into a copy of the synthetic host harness
 * under tools/harness/ — a minimal stand-in for src/StoreMediaApi that ships
 * the V2 contracts (Broker/ICommand/IQuery, IUnitOfWork, IRepository,
 * StoreMediaDbContext + V2 DI registration, both pre-carrying the injection
 * marker pairs). Then it runs the real CLI to init + generate every test_data
 * entity into it, and builds + tests the result.
 *
 * Requires the .NET SDK on PATH and packages/core already built
 * (`npm run build`, so dist/cli.js exists).
 */
'use strict';

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACK_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const CORE_CLI = join(REPO_ROOT, 'packages', 'core', 'dist', 'cli.js');
const HARNESS_DIR = join(__dirname, 'harness');
const TEST_DATA_DIR = join(PACK_DIR, 'test_data');
const PACK_SPEC = `backend=${REPO_ROOT}@packages/templates-dotnet/v8-controller-storemedia-v2`;
const TEST_CSPROJ = join('tests', 'StoreMediaApi.UnitTests', 'StoreMediaApi.UnitTests.csproj');
const MAIN_CSPROJ = join('src', 'StoreMediaApi', 'StoreMediaApi.csproj');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function runOrDie(label, command, args, cwd) {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    console.error(`\n--- ${label} failed (exit ${result.status}) ---`);
    console.error(result.stdout);
    console.error(result.stderr);
    return false;
  }
  return true;
}

/** One manifest per distinct entity. */
function manifestsByEntity(dir) {
  const seen = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dir, name);
    const manifest = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!seen.has(manifest.entity)) seen.set(manifest.entity, filePath);
  }
  return [...seen.values()];
}

function main() {
  if (!existsSync(CORE_CLI)) {
    console.error(`validate-build.mjs: ${CORE_CLI} not found — run "npm run build" (in packages/core) first`);
    process.exit(1);
  }
  if (run('dotnet', ['--version'], REPO_ROOT).status !== 0) {
    console.error('validate-build.mjs: "dotnet" not found on PATH — install the .NET SDK to run this check');
    process.exit(1);
  }

  const manifests = manifestsByEntity(TEST_DATA_DIR);
  console.log(`Scaffolding ${manifests.length} V2 entit${manifests.length === 1 ? 'y' : 'ies'} into a copy of the synthetic host harness...\n`);

  const sampleDir = mkdtempSync(join(tmpdir(), 'scaffold-storemedia-v2-buildcheck-'));

  function runSteps() {
    cpSync(HARNESS_DIR, sampleDir, { recursive: true });

    if (!runOrDie('scaffold init', process.execPath, [CORE_CLI, 'init', '--project-type', 'dotnet', '--pack', PACK_SPEC], sampleDir)) return false;

    for (const manifest of manifests) {
      if (!runOrDie(`scaffold generate (${manifest})`, process.execPath, [CORE_CLI, 'generate', '--manifest', manifest], sampleDir)) return false;
    }

    if (!runOrDie('dotnet build (host + generated V2)', 'dotnet', ['build', MAIN_CSPROJ, '-warnaserror:false'], sampleDir)) return false;
    if (!runOrDie('dotnet test (V2 handler tests)', 'dotnet', ['test', TEST_CSPROJ, '--nologo'], sampleDir)) return false;
    return true;
  }

  let ok = false;
  try {
    ok = runSteps();
  } finally {
    rmSync(sampleDir, { recursive: true, force: true });
  }

  if (!ok) {
    console.error('\nvalidate-build.mjs: FAILED');
    process.exit(1);
  }
  console.log('\nvalidate-build.mjs: OK — all V2 fixtures generated, built, and tested.');
}

main();
