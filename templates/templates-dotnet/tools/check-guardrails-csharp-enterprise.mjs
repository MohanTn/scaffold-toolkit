#!/usr/bin/env node
/**
 * tools/check-guardrails-csharp-enterprise.mjs
 * Edit-surface contract for the csharp-enterprise pack, driven through the real
 * `scaffold add` flow: injected wiring (controller actions, repository
 * interface signatures, DI/health-check registrations) stays frozen for the
 * host agent, while AI_IMPLEMENTATION seams (handlers, the partial-class
 * custom repository method, scheduler/outbox bodies) stay editable.
 *
 * Requires the CLI already built (dist/cli.js at the repo root). No .NET SDK needed.
 */
'use strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORE_CLI = join(REPO_ROOT, 'dist', 'cli.js');
const PACK_SPEC = `backend=${REPO_ROOT}@templates/templates-dotnet/csharp-enterprise`;

function run(args, cwd) {
  const result = spawnSync(process.execPath, [CORE_CLI, ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function runOrDie(label, args, cwd) {
  const result = run(args, cwd);
  if (result.status !== 0) {
    console.error(`\n--- ${label} failed ---\n${result.stdout}\n${result.stderr}`);
    process.exit(1);
  }
}

let failures = 0;

function expectVerdict(label, cwd, expectAllow, file, tool, oldString) {
  const args = ['check-edit', '--file', file, '--tool', tool];
  if (oldString !== undefined) args.push('--old-string', oldString);
  const result = run(args, cwd);
  const allowed = result.status === 0;
  if (allowed === expectAllow) {
    console.log(`  ok: ${label} → ${allowed ? 'allowed' : 'blocked'}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${label} — expected ${expectAllow ? 'allowed' : 'blocked'}, got ${allowed ? 'allowed' : 'blocked'}\n    ${result.stdout.trim()}`);
  }
}

function main() {
  if (!existsSync(CORE_CLI)) {
    console.error(`check-guardrails-csharp-enterprise.mjs: ${CORE_CLI} not found — run "npm run build" at the repo root first`);
    process.exit(1);
  }

  const sampleDir = mkdtempSync(join(tmpdir(), 'scaffold-csharp-enterprise-guardrails-'));
  try {
    runOrDie('scaffold init', ['init', '--project-type', 'dotnet', '--pack', PACK_SPEC], sampleDir);
    runOrDie('add feature Product', ['add', 'feature', '--name', 'Product', '--properties', 'Name:string,Price:decimal'], sampleDir);
    runOrDie('add custom query', ['add', 'custom', '--name', 'GetActiveProducts', '--return-type', 'int', '--parameters', 'minPrice:decimal', '--target-controller', 'ProductsController'], sampleDir);
    runOrDie('add health-check', ['add', 'health-check', '--name', 'Database'], sampleDir);

    const APP = 'src/Company.MyProject';
    const controllerFile = `${APP}/Api/Controllers/ProductsController.cs`;
    const ifaceFile = `${APP}/Application/Common/Interfaces/IProductRepository.cs`;
    const customRepoFile = `${APP}/Infrastructure/Persistence/Repositories/ProductRepository.GetActiveProducts.cs`;
    const customHandlerFile = `${APP}/Application/Features/Products/Queries/GetActiveProducts/GetActiveProductsQueryHandler.cs`;
    const programFile = `${APP}/Program.cs`;
    const src = (rel) => readFileSync(join(sampleDir, rel), 'utf8');

    console.log('\nInjected wiring must stay frozen:');
    expectVerdict('write controller', sampleDir, false, controllerFile, 'write');
    expectVerdict('edit injected controller action', sampleDir, false, controllerFile, 'edit', 'public async Task<ActionResult<int>> GetActiveProductsAsync(');
    expectVerdict('edit injected repo interface signature', sampleDir, false, ifaceFile, 'edit', 'Task<int> GetActiveProductsAsync(decimal minPrice, CancellationToken cancellationToken = default);');
    expectVerdict('edit health-check registration in Program.cs', sampleDir, false, programFile, 'edit', 'AddCheck<Company.MyProject.Infrastructure.HealthChecks.DatabaseHealthCheck>');

    console.log('\nAI_IMPLEMENTATION seams must stay editable:');
    expectVerdict('edit custom repo method body (partial-class seam)', sampleDir, true, customRepoFile, 'edit', 'throw new NotImplementedException("GetActiveProductsAsync is not implemented yet");');
    expectVerdict('edit custom handler body', sampleDir, true, customHandlerFile, 'edit', 'return await _repository.GetActiveProductsAsync(request.MinPrice, cancellationToken);');
    expectVerdict('edit health-check body', sampleDir, true, `${APP}/Infrastructure/HealthChecks/DatabaseHealthCheck.cs`, 'edit', 'return Task.FromResult(HealthCheckResult.Healthy("Database is healthy"));');

    // Guard against vacuous "blocked because not found": every old_string
    // above must actually exist in the generated output.
    for (const [rel, needle] of [
      [controllerFile, 'public async Task<ActionResult<int>> GetActiveProductsAsync('],
      [ifaceFile, 'Task<int> GetActiveProductsAsync(decimal minPrice, CancellationToken cancellationToken = default);'],
      [customRepoFile, 'throw new NotImplementedException("GetActiveProductsAsync is not implemented yet");'],
      [customHandlerFile, 'return await _repository.GetActiveProductsAsync(request.MinPrice, cancellationToken);'],
      [programFile, 'AddCheck<Company.MyProject.Infrastructure.HealthChecks.DatabaseHealthCheck>'],
    ]) {
      if (!src(rel).includes(needle)) {
        failures += 1;
        console.error(`  FAIL: expected "${needle}" in generated ${rel}`);
      }
    }
  } finally {
    rmSync(sampleDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\ncheck-guardrails-csharp-enterprise.mjs: FAILED — ${failures} assertion(s) did not hold`);
    process.exit(1);
  }
  console.log('\ncheck-guardrails-csharp-enterprise.mjs: OK — injected wiring frozen, AI seams editable.');
}

main();
