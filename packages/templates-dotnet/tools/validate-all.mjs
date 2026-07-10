#!/usr/bin/env node
/**
 * tools/validate-all.mjs
 * CI/local entry point: runs the render.mjs smoke test (see that file's header
 * for what it does and does not check) against every pack folder in the repo,
 * using the shared example intent manifest. A pack folder is any top-level
 * directory containing a manifest.templates.json, so a newly added pack is
 * picked up without editing this script.
 */
'use strict';

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MANIFEST = join(ROOT, 'examples', 'basic-invoice.manifest.json');
const RENDER_SCRIPT = join(__dirname, 'render.mjs');

function discoverPacks() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(ROOT, name, 'manifest.templates.json')))
    .sort();
}

function main() {
  const packs = discoverPacks();
  if (packs.length === 0) {
    console.error('validate-all.mjs: no pack folders found (expected at least one manifest.templates.json)');
    process.exit(1);
  }

  console.log(`Validating ${packs.length} pack(s): ${packs.join(', ')}\n`);

  const workDir = mkdtempSync(join(tmpdir(), 'scaffold-validate-'));
  let failures = 0;

  for (const pack of packs) {
    const outDir = join(workDir, pack);
    console.log(`=== ${pack} ===`);
    try {
      execFileSync(
        process.execPath,
        [RENDER_SCRIPT, '--pack', pack, '--manifest', MANIFEST, '--out', outDir],
        { stdio: 'inherit', cwd: ROOT },
      );
    } catch {
      failures++;
    }
    console.log('');
  }

  rmSync(workDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`validate-all.mjs: ${failures} of ${packs.length} pack(s) failed validation`);
    process.exit(1);
  }

  console.log(`All ${packs.length} pack(s) validated successfully.`);
}

main();
