/**
 * Smoke test for `bin/gh-scaffold`.
 *
 * Why this exists: the rest of the shim's test suite (`dispatch.test.mjs`,
 * `precheck.test.mjs`) imports `src/index.mjs` directly via the Node test
 * runner, which bypasses `bin/gh-scaffold` entirely. That means an
 * ERR_MODULE_NOT_FOUND or any other load-time error in the bin script itself
 * — for example, an import like `../src/index.js` against a source file
 * named `index.mjs`, which Node ESM does NOT auto-fallback-resolve — is
 * invisible to the existing suite. This file spawns the bin via
 * `child_process.execFile` and asserts a benign invocation exits 0; that
 * proves the entire import graph of the bin loaded successfully.
 *
 * We exercise `--version` because it's the lightest dispatch path: it
 * doesn't shell out to scaffold-core, doesn't touch disk, and doesn't need
 * any PATH setup. If the bin loads and tokenises argv, `--version` exits 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { SHIM_BIN, execWrapper } from './_harness.mjs';

test('bin/gh-scaffold: --version exits 0 — proves the bin entry loads its module graph', async () => {
  assert.ok(existsSync(SHIM_BIN), `bin entry missing at ${SHIM_BIN}`);
  // Permission bit: if the bin lost +x, every spawn under any CI runner fails.
  // This keeps a chmod regression from masquerading as "bin throws on import".
  assert.ok((statSync(SHIM_BIN).mode & 0o111) !== 0, `${SHIM_BIN} is not executable — run \`chmod +x\` on the bin entry`);

  const result = await execWrapper(SHIM_BIN, ['--version']);

  // Exit 0 is the load-time proof. If the bin threw ERR_MODULE_NOT_FOUND
  // (the .js→.mjs bug class) the status would be 1 with a stack trace on stderr.
  assert.equal(result.status, 0, `expected --version to exit 0; got status=${result.status}; stderr=${result.stderr}`);
  // Version string comes from src/version.mjs readOwnPackageJson + dispatch printVersion().
  assert.match(result.stdout.trim(), /^gh-scaffold \d+\.\d+\.\d+/, `unexpected version output: ${JSON.stringify(result.stdout)}`);
});

test('bin/gh-scaffold: unknown subcommand exits 2 with a usage hint — proves dispatch runs after import', async () => {
  // Imports + dispatch both succeed and we exercise the binary's overall shape.
  // A pure --version check doesn't prove dispatch ran end-to-end; an unknown
  // subcommand only reaches the "unknown subcommand" branch after both the
  // import succeeded AND the dispatcher got control.
  const result = await execWrapper(SHIM_BIN, ['definitely-not-a-real-subcommand']);

  assert.equal(result.status, 2, `expected exit 2 on unknown subcommand; got status=${result.status}; stderr=${result.stderr}`);
  assert.match(result.stderr, /unknown subcommand "definitely-not-a-real-subcommand"/);
});
