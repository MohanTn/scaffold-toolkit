#!/usr/bin/env node
/**
 * tools/check-guardrails.mjs
 * Proves the pack's edit-surface contract with the real CLI: after `scaffold
 * generate`, an LLM host is allowed to edit ONLY the AI_IMPLEMENTATION block
 * interiors while every scaffold-managed surface (module exports, test
 * structure, frozen arrange/act regions) stays blocked by `scaffold check-edit`.
 *
 * Requires packages/core already built (dist/cli.js). No Node SDK setup needed.
 */
'use strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORE_CLI = join(REPO_ROOT, 'packages', 'core', 'dist', 'cli.js');
const MANIFEST = join(REPO_ROOT, 'packages', 'templates-node', 'test_data', 'module-billing.json');
const PACK_SPEC = `module=${REPO_ROOT}@packages/templates-node/generic-v1`;

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

/** Assert a check-edit verdict: expectAllow maps to exit 0, block to exit 1. */
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
    console.error(`check-guardrails.mjs: ${CORE_CLI} not found — run "npm run build" (in packages/core) first`);
    process.exit(1);
  }

  const sampleDir = mkdtempSync(join(tmpdir(), 'scaffold-templates-node-guardrails-'));
  try {
    runOrDie('scaffold init', ['init', '--project-type', 'node', '--pack', PACK_SPEC], sampleDir);
    runOrDie('scaffold templates sync', ['templates', 'sync'], sampleDir);
    runOrDie('scaffold generate', ['generate', '--manifest', MANIFEST], sampleDir);

    const src = (rel) => readFileSync(join(sampleDir, rel), 'utf8');
    const moduleFile = 'src/features/Billing/Billing.ts';
    const moduleTestFile = 'src/features/Billing/Billing.test.ts';
    const registryFile = 'src/features/index.ts';

    console.log('\nPack-managed surfaces must stay frozen:');
    expectVerdict('write module file', sampleDir, false, moduleFile, 'write');
    expectVerdict('write registry file', sampleDir, false, registryFile, 'write');
    expectVerdict('edit registry exports', sampleDir, false, registryFile, 'edit', "export { Billing } from './Billing/Billing.js';");
    expectVerdict('edit module class signature', sampleDir, false, moduleFile, 'edit', 'export class Billing {');
    expectVerdict('edit test frozen arrange', sampleDir, false, moduleTestFile, 'edit', 'const instance = new Billing();');

    console.log('\nAI_IMPLEMENTATION blocks must stay editable:');
    expectVerdict('edit module run() body', sampleDir, true, moduleFile, 'edit', "throw new Error('not implemented');");
    expectVerdict('edit test assertions', sampleDir, true, moduleTestFile, 'edit', 'assert.throws(() => instance.run(input));');

    // Guard the assertions themselves
    const moduleContent = src(moduleFile);
    const testContent = src(moduleTestFile);
    const registryContent = src(registryFile);

    for (const [rel, needle] of [
      [moduleFile, "throw new Error('not implemented');"],
      [moduleTestFile, 'const instance = new Billing();'],
      [moduleTestFile, 'assert.throws(() => instance.run(input));'],
      [registryFile, "export { Billing } from './Billing/Billing.js';"],
    ]) {
      const fileContent = rel === moduleFile ? moduleContent : rel === moduleTestFile ? testContent : registryContent;
      if (!fileContent.includes(needle)) {
        failures += 1;
        console.error(`  FAIL: expected "${needle}" in generated ${rel}`);
      }
    }
  } finally {
    rmSync(sampleDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\ncheck-guardrails.mjs: FAILED — ${failures} assertion(s) did not hold`);
    process.exit(1);
  }
  console.log('\ncheck-guardrails.mjs: OK — pack surfaces frozen, AI_IMPLEMENTATION blocks editable.');
}

main();
