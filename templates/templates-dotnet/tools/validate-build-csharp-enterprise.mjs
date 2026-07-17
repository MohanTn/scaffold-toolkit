#!/usr/bin/env node
/**
 * tools/validate-build-csharp-enterprise.mjs
 * Compile proof for the csharp-enterprise pack, driven through the real
 * `scaffold add` command family (not raw generate) so the compiler layer,
 * artifact scoping, `when` conditionals, and marker injections are all
 * exercised exactly the way a host agent uses them. Scaffolds a throwaway
 * single-project .NET solution, layers every enterprise artifact on top,
 * then runs `dotnet build`/`dotnet test`. Variant projects prove the
 * combined-repository layout and each cloud provider actually compile.
 *
 * Requires the .NET SDK on PATH and the CLI already built at the repo root
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
const CORE_CLI = join(REPO_ROOT, 'dist', 'cli.js');
const PACK_SPEC = `backend=${REPO_ROOT}@templates/templates-dotnet/csharp-enterprise`;

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

function scaffold(label, args, cwd) {
  return runOrDie(label, process.execPath, [CORE_CLI, ...args], cwd);
}

function buildSolution(label, dir) {
  const sln = readdirSync(dir).find((name) => name.endsWith('.sln'));
  if (!sln) {
    console.error(`validate-build-csharp-enterprise.mjs: no .sln found for ${label}`);
    return false;
  }
  const slnPath = join(dir, sln);
  return runOrDie(`dotnet restore (${label})`, 'dotnet', ['restore', slnPath], dir) && runOrDie(`dotnet build (${label})`, 'dotnet', ['build', slnPath, '--nologo'], dir);
}

/** Runs `steps` inside a fresh initialized sample dir; always cleans up. */
function inFreshProject(label, steps) {
  console.log(`\n=== ${label} ===`);
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-csharp-enterprise-buildcheck-'));
  let ok;
  try {
    ok = scaffold('scaffold init', ['init', '--project-type', 'dotnet', '--pack', PACK_SPEC], dir) && steps(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!ok) {
    console.error(`\nvalidate-build-csharp-enterprise.mjs: FAILED — ${label}`);
    process.exit(1);
  }
}

function main() {
  if (!existsSync(CORE_CLI)) {
    console.error(`validate-build-csharp-enterprise.mjs: ${CORE_CLI} not found — run "npm run build" at the repo root first`);
    process.exit(1);
  }
  if (run('dotnet', ['--version'], REPO_ROOT).status !== 0) {
    console.error('validate-build-csharp-enterprise.mjs: "dotnet" not found on PATH — install the .NET SDK to run this check');
    process.exit(1);
  }

  // --- Main sample: every artifact kind layered into one project ------------
  inFreshProject('full enterprise sample (split repository layout)', (dir) => {
    if (!scaffold('add feature Product', ['add', 'feature', '--name', 'Product', '--properties', 'Name:string,Price:decimal,IsActive:bool'], dir)) return false;
    if (!scaffold('add feature Campaign (ops subset)', ['add', 'feature', '--name', 'Campaign', '--properties', 'Name:string,Budget:decimal', '--operations', 'Create,Read'], dir)) return false;
    if (!scaffold('add custom query', ['add', 'custom', '--name', 'GetActiveProducts', '--return-type', 'int', '--parameters', 'minPrice:decimal', '--method', 'GET', '--target-controller', 'ProductsController'], dir)) return false;
    if (!scaffold('add custom command', ['add', 'custom', '--name', 'ArchiveStaleProducts', '--return-type', 'int', '--parameters', 'cutoffDays:int', '--method', 'POST', '--is-command', '--target-controller', 'ProductsController'], dir)) return false;
    if (!scaffold('add domain-event', ['add', 'domain-event', '--name', 'ProductCreated', '--entity', 'Product'], dir)) return false;
    if (!scaffold('add factory', ['add', 'factory', '--entity', 'Product'], dir)) return false;
    if (!scaffold('add helper guard', ['add', 'helper', '--name', 'guard'], dir)) return false;
    if (!scaffold('add helper crypto', ['add', 'helper', '--name', 'crypto'], dir)) return false;
    if (!scaffold('add scheduler-job', ['add', 'scheduler-job', '--name', 'NightlyCleanup'], dir)) return false;
    if (!scaffold('add health-check', ['add', 'health-check', '--name', 'Database'], dir)) return false;
    if (!scaffold('add outbox-processor', ['add', 'outbox-processor'], dir)) return false;

    // Injections landed where expected before paying for the dotnet build.
    const program = readFileSync(join(dir, 'src/Company.MyProject/Program.cs'), 'utf8');
    if (!program.includes('DatabaseHealthCheck')) {
      console.error('validate-build-csharp-enterprise.mjs: health-check registration missing from Program.cs');
      return false;
    }
    const controller = readFileSync(join(dir, 'src/Company.MyProject/Api/Controllers/ProductsController.cs'), 'utf8');
    if (!controller.includes('GetActiveProductsAsync') || !controller.includes('ArchiveStaleProductsAsync')) {
      console.error('validate-build-csharp-enterprise.mjs: custom endpoint actions missing from ProductsController.cs');
      return false;
    }
    const iface = readFileSync(join(dir, 'src/Company.MyProject/Application/Common/Interfaces/IProductRepository.cs'), 'utf8');
    if (!iface.includes('GetActiveProductsAsync') || !iface.includes('ArchiveStaleProductsAsync')) {
      console.error('validate-build-csharp-enterprise.mjs: custom repository methods missing from IProductRepository.cs');
      return false;
    }

    if (!buildSolution('full sample', dir)) return false;
    const testCsproj = join(dir, 'tests', 'Company.MyProject.UnitTests', 'Company.MyProject.UnitTests.csproj');
    return existsSync(testCsproj) ? runOrDie('dotnet test', 'dotnet', ['test', testCsproj, '--nologo'], dir) : true;
  });

  // --- Combined repository layout + custom endpoint into the combined file --
  inFreshProject('combined repository layout', (dir) => {
    if (!scaffold('add feature Order --combine', ['add', 'feature', '--name', 'Order', '--properties', 'Total:decimal,PlacedAt:DateTime', '--combine'], dir)) return false;
    if (!scaffold('add custom on combined repo', ['add', 'custom', '--name', 'CountOrders', '--return-type', 'int', '--target-controller', 'OrdersController', '--combine'], dir)) return false;

    const combinedPath = join(dir, 'src/Company.MyProject/Infrastructure/Persistence/Repositories/OrderRepository.cs');
    const combined = readFileSync(combinedPath, 'utf8');
    if (!combined.includes('public interface IOrderRepository') || !combined.includes('CountOrdersAsync')) {
      console.error('validate-build-csharp-enterprise.mjs: combined repository missing interface or injected method');
      return false;
    }
    if (existsSync(join(dir, 'src/Company.MyProject/Application/Common/Interfaces/IOrderRepository.cs'))) {
      console.error('validate-build-csharp-enterprise.mjs: split interface file exists despite --combine');
      return false;
    }
    return buildSolution('combined layout', dir);
  });

  // --- Each cloud provider variant compiles against its real SDK ------------
  for (const provider of ['aws', 'azure', 'gcp']) {
    inFreshProject(`cloud provider: ${provider}`, (dir) => {
      if (!scaffold('add feature Media', ['add', 'feature', '--name', 'Media', '--properties', 'FileName:string', '--operations', 'Create,Read'], dir)) return false;
      if (!scaffold(`add cloud-provider ${provider}`, ['add', 'cloud-provider', '--provider', provider], dir)) return false;
      const csproj = readFileSync(join(dir, 'src/Company.MyProject/Company.MyProject.csproj'), 'utf8');
      if (!/AWSSDK\.S3|Azure\.Storage\.Blobs|Google\.Cloud\.Storage\.V1/.test(csproj)) {
        console.error(`validate-build-csharp-enterprise.mjs: ${provider} package reference missing from csproj`);
        return false;
      }
      return buildSolution(`cloud ${provider}`, dir);
    });
  }

  // --- Raw manifest layer still drives csharp-enterprise (postgres provider variant) -------
  inFreshProject('raw manifest layer: postgres provider', (dir) => {
    const manifestOut = join(dir, 'ledger.manifest.json');
    if (
      !scaffold('manifest new', [
        'manifest', 'new', '--stack', 'backend', '--entity', 'Ledger', '--field', 'Amount:decimal',
        '--option', 'database.provider=postgres',
        '--artifact', 'base', '--artifact', 'op-create', '--artifact', 'op-read', '--artifact', 'op-update', '--artifact', 'op-delete',
        '--out', manifestOut,
      ], dir)
    ) return false;
    if (!scaffold('generate (postgres)', ['generate', '--manifest', manifestOut], dir)) return false;
    const csproj = readFileSync(join(dir, 'src/Company.MyProject/Company.MyProject.csproj'), 'utf8');
    if (!csproj.includes('Npgsql.EntityFrameworkCore.PostgreSQL')) {
      console.error('validate-build-csharp-enterprise.mjs: postgres provider package missing from csproj');
      return false;
    }
    return buildSolution('postgres variant', dir);
  });

  console.log('\nvalidate-build-csharp-enterprise.mjs: OK — enterprise sample, combined layout, 3 cloud providers, and the raw-manifest postgres variant all generated and compiled.');
}

main();
