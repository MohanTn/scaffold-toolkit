#!/usr/bin/env node
/**
 * tools/validate-build.mjs
 * The deeper check render.mjs/validate-all.mjs don't do: renders every unique
 * entity found in ../test_data through the real `scaffold generate`
 * CLI into a throwaway sample .NET project, then shells out to `dotnet
 * build`/`dotnet test` against it. render-only and validate-pack checks stop
 * at "generate didn't throw" — most of the bugs this script exists to catch
 * (namespace mismatches, missing usings, wrong method names) are C# compile
 * errors that only `dotnet build` surfaces.
 *
 * Requires the .NET SDK on PATH and packages/core already built
 * (`npm run build`, so dist/cli.js exists).
 */
'use strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORE_CLI = join(REPO_ROOT, 'packages', 'core', 'dist', 'cli.js');
const TEST_DATA_DIR = join(REPO_ROOT, 'packages', 'templates-dotnet', 'test_data');
const PACK_SPEC = `backend=${REPO_ROOT}@packages/templates-dotnet/v8-controller`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function runOrDie(label, command, args, cwd) {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    console.error(`\n--- ${label} failed ---`);
    console.error(result.stdout);
    console.error(result.stderr);
    return false;
  }
  return true;
}

/** One manifest file per distinct `entity` value — the 52 test_data fixtures
 * repeat the same entity across many files on purpose (each names a specific
 * artifact), so generating all of them would just re-hit the same entity's
 * "already exists" guard 35 times over. */
function dedupeByEntity(dir) {
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

  const manifests = dedupeByEntity(TEST_DATA_DIR);
  console.log(`Scaffolding ${manifests.length} unique entit${manifests.length === 1 ? 'y' : 'ies'} from test_data/ into a throwaway sample project...\n`);

  const sampleDir = mkdtempSync(join(tmpdir(), 'scaffold-templates-dotnet-buildcheck-'));

  function runSteps() {
    if (!runOrDie('scaffold init', process.execPath, [CORE_CLI, 'init', '--project-type', 'dotnet', '--pack', PACK_SPEC], sampleDir)) return false;
    if (!runOrDie('scaffold templates sync', process.execPath, [CORE_CLI, 'templates', 'sync'], sampleDir)) return false;

    for (const manifestPath of manifests) {
      const entity = JSON.parse(readFileSync(manifestPath, 'utf8')).entity;
      if (!runOrDie(`scaffold generate (${entity})`, process.execPath, [CORE_CLI, 'generate', '--manifest', manifestPath], sampleDir)) return false;
    }

    const sln = readdirSync(sampleDir).find((name) => name.endsWith('.sln'));
    if (!sln) {
      console.error('validate-build.mjs: no .sln file found in the scaffolded sample project');
      return false;
    }
    const slnPath = join(sampleDir, sln);

    if (!runOrDie('dotnet restore', 'dotnet', ['restore', slnPath], sampleDir)) return false;
    if (!runOrDie('dotnet build', 'dotnet', ['build', slnPath, '--nologo'], sampleDir)) return false;

    const testCsproj = join(sampleDir, 'tests', 'Company.MyProject.Application.UnitTests', 'Company.MyProject.Application.UnitTests.csproj');
    if (existsSync(testCsproj) && !runOrDie('dotnet test', 'dotnet', ['test', testCsproj, '--nologo'], sampleDir)) return false;

    return true;
  }

  let ok;
  try {
    ok = runSteps();
  } finally {
    rmSync(sampleDir, { recursive: true, force: true });
  }

  if (!ok) {
    console.error('\nvalidate-build.mjs: FAILED — see the failing step above');
    process.exit(1);
  }
  console.log(`\nvalidate-build.mjs: OK — ${manifests.length} entities generated, dotnet build and test both succeeded.`);
}

main();
