#!/usr/bin/env node
/**
 * tools/validate-build.mjs
 * Full integration test: scaffolds real modules from test_data through the
 * `scaffold` CLI, then builds and tests the output project with TypeScript
 * and node:test. Validates that the pack-level commentSyntax override (`///`
 * for .ts files) is exercised in the generated code, and that injections
 * accumulate correctly across multiple generations.
 *
 * Requires packages/core already built (dist/cli.js).
 */
'use strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORE_CLI = join(REPO_ROOT, 'packages', 'core', 'dist', 'cli.js');
const TEST_DATA_DIR = join(REPO_ROOT, 'packages', 'templates-node', 'test_data');
const BILLING_MANIFEST = join(TEST_DATA_DIR, 'module-billing.json');
const INVOICING_MANIFEST = join(TEST_DATA_DIR, 'module-invoicing.json');
const PACK_SPEC = `module=${REPO_ROOT}@packages/templates-node/generic-v1`;

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

function main() {
  if (!existsSync(CORE_CLI)) {
    console.error(`validate-build.mjs: ${CORE_CLI} not found — run "npm run build" (in packages/core) first`);
    process.exit(1);
  }

  console.log('Scaffolding Node.js TypeScript modules into a throwaway sample project...\n');

  const sampleDir = mkdtempSync(join(tmpdir(), 'scaffold-templates-node-buildcheck-'));

  function runSteps() {
    if (!runOrDie('scaffold init', process.execPath, [CORE_CLI, 'init', '--project-type', 'node', '--pack', PACK_SPEC], sampleDir)) return false;
    if (!runOrDie('scaffold templates sync', process.execPath, [CORE_CLI, 'templates', 'sync'], sampleDir)) return false;

    // Step 3: Use the new --input CLI flag to create a manifest dynamically
    if (!runOrDie('scaffold manifest new', process.execPath, [CORE_CLI, 'manifest', 'new', '--stack', 'module', '--input', 'name=Billing', '--out', join(sampleDir, 'billing.manifest.json')], sampleDir)) return false;

    // Step 4: Generate the Billing module
    if (!runOrDie('scaffold generate (Billing)', process.execPath, [CORE_CLI, 'generate', '--manifest', join(sampleDir, 'billing.manifest.json')], sampleDir)) return false;

    // Step 5: Assert that the pack-level commentSyntax override fired
    const indexPath = join(sampleDir, 'src/features/index.ts');
    const indexContent = readFileSync(indexPath, 'utf8');
    if (!indexContent.includes('/// SCAFFOLD:REGISTRY:START')) {
      console.error('validate-build.mjs: pack-level commentSyntax override did not fire — expected /// prefix, not //');
      return false;
    }
    if (!indexContent.includes("export { Billing } from './Billing/Billing.js';")) {
      console.error('validate-build.mjs: Billing export line not found in registry');
      return false;
    }

    // Step 6: Generate the Invoicing module from hand-authored fixture
    if (!runOrDie('scaffold generate (Invoicing)', process.execPath, [CORE_CLI, 'generate', '--manifest', INVOICING_MANIFEST], sampleDir)) return false;

    // Step 7: Assert both exports are present (append accumulates)
    const indexAfterInvoicing = readFileSync(indexPath, 'utf8');
    if (!indexAfterInvoicing.includes("export { Billing } from './Billing/Billing.js';")) {
      console.error('validate-build.mjs: Billing export missing after Invoicing generation');
      return false;
    }
    if (!indexAfterInvoicing.includes("export { Invoicing } from './Invoicing/Invoicing.js';")) {
      console.error('validate-build.mjs: Invoicing export line not found in registry');
      return false;
    }

    // Step 8: Negative-path check — invalid name pattern
    const invalidManifest = join(sampleDir, 'invalid.manifest.json');
    const invalidContent = JSON.stringify({ manifestSchemaVersion: 1, targetStack: 'module', name: 'notPascalCase' });
    writeFileSync(invalidManifest, invalidContent);
    const invalidResult = run(process.execPath, [CORE_CLI, 'generate', '--manifest', invalidManifest], sampleDir);
    if (invalidResult.status === 0) {
      console.error('validate-build.mjs: scaffold generate should have rejected name="notPascalCase"');
      return false;
    }

    // Step 9: Symlink node_modules for pipeline-worker compatibility
    try {
      const repoNodeModules = join(REPO_ROOT, 'node_modules');
      const sampleNodeModulesLink = join(sampleDir, 'node_modules');
      if (existsSync(sampleNodeModulesLink)) {
        unlinkSync(sampleNodeModulesLink);
      }
      symlinkSync(repoNodeModules, sampleNodeModulesLink);
    } catch (e) {
      console.error('validate-build.mjs: failed to symlink node_modules:', e instanceof Error ? e.message : e);
      return false;
    }

    // Step 10: TypeScript build
    if (!runOrDie('npm run build', 'npm', ['run', 'build'], sampleDir)) return false;

    // Step 11: Tests
    if (!runOrDie('npm test', 'npm', ['test'], sampleDir)) return false;

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

  console.log('\nvalidate-build.mjs: OK — sample project scaffolded, built, and tested successfully.');
}

main();
