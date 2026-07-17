#!/usr/bin/env node
/**
 * tools/validate-build-react-app.mjs
 * Compile proof for the react-app pack, driven through the real `scaffold
 * add` command family (not raw generate) so the compiler layer, artifact
 * scoping, and barrel injections are all exercised exactly the way a host
 * agent uses them. Scaffolds a throwaway Vite React project, layers every
 * component-level artifact on top, then runs `npm install`, `npm run
 * build`, `npm test`, and `npm run lint`.
 *
 * Requires network access for npm install and the CLI already built at the
 * repo root (`npm run build`, so dist/cli.js exists).
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

function npmToolchain(label, dir) {
  return (
    runOrDie(`npm install (${label})`, 'npm', ['install'], dir) &&
    runOrDie(`npm run build (${label})`, 'npm', ['run', 'build'], dir) &&
    runOrDie(`npm test (${label})`, 'npm', ['test'], dir) &&
    runOrDie(`npm run lint (${label})`, 'npm', ['run', 'lint'], dir)
  );
}

/** Runs `steps` inside a fresh initialized sample dir; always cleans up. */
function inFreshProject(label, steps) {
  console.log(`\n=== ${label} ===`);
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-react-app-buildcheck-'));
  let ok;
  try {
    ok = scaffold('scaffold init', ['init', '--project-type', 'js-family', '--pack', PACK_SPEC], dir) && steps(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!ok) {
    console.error(`\nvalidate-build-react-app.mjs: FAILED — ${label}`);
    process.exit(1);
  }
}

function main() {
  if (!existsSync(CORE_CLI)) {
    console.error(`validate-build-react-app.mjs: ${CORE_CLI} not found — run "npm run build" at the repo root first`);
    process.exit(1);
  }

  inFreshProject('full react-app sample (every artifact kind)', (dir) => {
    if (!scaffold('add component Button', ['add', 'component', '--name', 'Button'], dir)) return false;
    if (!scaffold('add hook UseToggle', ['add', 'hook', '--name', 'UseToggle'], dir)) return false;
    if (!scaffold('add page ProductsPage', ['add', 'page', '--name', 'ProductsPage'], dir)) return false;
    if (!scaffold('add context Auth', ['add', 'context', '--name', 'Auth'], dir)) return false;
    if (!scaffold('add api-client Products', ['add', 'api-client', '--name', 'Products'], dir)) return false;

    // Barrel injections landed where expected before paying for npm install.
    const checks = [
      ['src/components/index.js', "export { default as Button } from './Button/Button.jsx';"],
      ['src/hooks/index.js', "export { default as useToggle } from './useToggle.js';"],
      ['src/pages/index.js', "export { default as ProductsPage } from './ProductsPage/ProductsPage.jsx';"],
      ['src/context/index.js', "export { AuthProvider, useAuth } from './AuthContext.jsx';"],
      ['src/api/index.js', "export * as productsApi from './productsApi.js';"],
    ];
    for (const [rel, needle] of checks) {
      const content = readFileSync(join(dir, rel), 'utf8');
      if (!content.includes(needle)) {
        console.error(`validate-build-react-app.mjs: expected "${needle}" in ${rel}`);
        return false;
      }
    }

    return npmToolchain('full sample', dir);
  });

  console.log('\nvalidate-build-react-app.mjs: OK — every artifact kind generated, built, tested, and linted.');
}

main();
