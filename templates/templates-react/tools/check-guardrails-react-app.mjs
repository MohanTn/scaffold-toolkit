#!/usr/bin/env node
/**
 * tools/check-guardrails-react-app.mjs
 * Edit-surface contract for the react-app pack, driven through the real
 * `scaffold add` flow: injected barrel exports stay frozen for the host
 * agent, while AI_IMPLEMENTATION seams (component/hook/page/context bodies,
 * the api-client's optional extension seam) stay editable.
 *
 * Requires the CLI already built (dist/cli.js at the repo root). No npm
 * install needed — check-edit is a structural, filesystem-only check.
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
const PACK_SPEC = `frontend=${REPO_ROOT}@templates/templates-react/react-app`;

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
    console.error(`check-guardrails-react-app.mjs: ${CORE_CLI} not found — run "npm run build" at the repo root first`);
    process.exit(1);
  }

  const sampleDir = mkdtempSync(join(tmpdir(), 'scaffold-react-app-guardrails-'));
  try {
    runOrDie('scaffold init', ['init', '--project-type', 'js-family', '--pack', PACK_SPEC], sampleDir);
    runOrDie('add component Button', ['add', 'component', '--name', 'Button'], sampleDir);
    runOrDie('add hook UseToggle', ['add', 'hook', '--name', 'UseToggle'], sampleDir);
    runOrDie('add context Auth', ['add', 'context', '--name', 'Auth'], sampleDir);
    runOrDie('add api-client Products', ['add', 'api-client', '--name', 'Products'], sampleDir);

    const componentsIndex = 'src/components/index.js';
    const hooksIndex = 'src/hooks/index.js';
    const buttonFile = 'src/components/Button/Button.jsx';
    const hookFile = 'src/hooks/useToggle.js';
    const contextFile = 'src/context/AuthContext.jsx';
    const apiFile = 'src/api/productsApi.js';
    const src = (rel) => readFileSync(join(sampleDir, rel), 'utf8');

    console.log('\nInjected wiring must stay frozen:');
    expectVerdict('write barrel file directly', sampleDir, false, componentsIndex, 'write');
    expectVerdict('edit injected component export line', sampleDir, false, componentsIndex, 'edit', "export { default as Button } from './Button/Button.jsx';");
    expectVerdict('edit injected hook export line', sampleDir, false, hooksIndex, 'edit', "export { default as useToggle } from './useToggle.js';");

    console.log('\nAI_IMPLEMENTATION seams must stay editable:');
    expectVerdict('edit component body (required seam)', sampleDir, true, buttonFile, 'edit', 'data-testid="button"');
    expectVerdict('edit hook body (required seam)', sampleDir, true, hookFile, 'edit', 'const [value, setValue] = useState(initialValue);');
    expectVerdict('edit context provider body (required seam)', sampleDir, true, contextFile, 'edit', 'const [state, setState] = useState(null);');
    expectVerdict('edit api-client optional extension seam', sampleDir, true, apiFile, 'edit', '// Add project-specific requests for Products here (custom filters, bulk operations, etc.).');

    console.log('\nGenerated code outside any seam must stay frozen:');
    expectVerdict('edit api-client getAll body (outside the seam)', sampleDir, false, apiFile, 'edit', 'const response = await fetch(BASE_URL);');

    // Guard against vacuous "blocked because not found": every old_string
    // above must actually exist in the generated output.
    for (const [rel, needle] of [
      [componentsIndex, "export { default as Button } from './Button/Button.jsx';"],
      [hooksIndex, "export { default as useToggle } from './useToggle.js';"],
      [buttonFile, 'data-testid="button"'],
      [hookFile, 'const [value, setValue] = useState(initialValue);'],
      [contextFile, 'const [state, setState] = useState(null);'],
      [apiFile, '// Add project-specific requests for Products here (custom filters, bulk operations, etc.).'],
      [apiFile, 'const response = await fetch(BASE_URL);'],
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
    console.error(`\ncheck-guardrails-react-app.mjs: FAILED — ${failures} assertion(s) did not hold`);
    process.exit(1);
  }
  console.log('\ncheck-guardrails-react-app.mjs: OK — injected barrel exports frozen, AI seams editable.');
}

main();
