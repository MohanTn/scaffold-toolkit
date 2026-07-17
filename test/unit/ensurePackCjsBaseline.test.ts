import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensurePackCjsBaseline } from '../../src/templates/sync.js';

test('ensurePackCjsBaseline: writes {"type":"commonjs"} next to a helpers.js that has no neighboring package.json', () => {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'scaffold-cjs-baseline-'));
  const helpersDir = path.join(packRoot, 'v1');
  mkdirSync(helpersDir, { recursive: true });
  writeFileSync(path.join(helpersDir, 'helpers.js'), 'module.exports = { register() {} };');

  ensurePackCjsBaseline(packRoot);

  const written = path.join(helpersDir, 'package.json');
  const parsed = JSON.parse(readFileSync(written, 'utf8'));
  assert.equal(parsed.type, 'commonjs');
});

test('ensurePackCjsBaseline: does NOT overwrite a pack-authored package.json (e.g. one with type:module)', () => {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'scaffold-cjs-baseline-'));
  const helpersDir = path.join(packRoot, 'v1');
  mkdirSync(helpersDir, { recursive: true });
  writeFileSync(path.join(helpersDir, 'helpers.js'), 'export default { register() {} };');
  const authored = { type: 'module', name: 'author-pack', version: '1.2.3' };
  writeFileSync(path.join(helpersDir, 'package.json'), JSON.stringify(authored));

  ensurePackCjsBaseline(packRoot);

  const parsed = JSON.parse(readFileSync(path.join(helpersDir, 'package.json'), 'utf8'));
  assert.equal(parsed.type, 'module', 'pack-authored type:module must be preserved');
  assert.equal(parsed.name, 'author-pack', 'pack-authored package.json fields must be preserved');
});

test('ensurePackCjsBaseline: does NOT create package.json in any directory when no helpers.js exists anywhere in the pack', () => {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'scaffold-cjs-baseline-'));
  const v1 = path.join(packRoot, 'v1');
  mkdirSync(v1, { recursive: true });
  writeFileSync(path.join(v1, 'manifest.templates.json'), '{"descriptorSchemaVersion":2,"packVersion":"v1","targets":[],"injections":[]}');

  ensurePackCjsBaseline(packRoot);

  assert.equal(JSON.parse(readFileSync(path.join(v1, 'manifest.templates.json'), 'utf8')).descriptorSchemaVersion, 2);
  const helperDirs = [path.join(packRoot), v1];
  for (const d of helperDirs) {
    // No package.json created anywhere because no helpers.js existed
    assert.equal(
      existsSyncFile(d, 'package.json'),
      false,
      `no package.json should be written under ${d}`,
    );
  }
});

test('ensurePackCjsBaseline: writes a separate package.json in *each* subdir that has a helpers.js (CJS scope is per-directory)', () => {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'scaffold-cjs-baseline-'));
  const a = path.join(packRoot, 'v1');
  const b = path.join(packRoot, 'v2', 'inner');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(path.join(a, 'helpers.js'), 'module.exports = {};');
  writeFileSync(path.join(b, 'helpers.js'), 'module.exports = {};');

  ensurePackCjsBaseline(packRoot);

  assert.equal(JSON.parse(readFileSync(path.join(a, 'package.json'), 'utf8')).type, 'commonjs');
  assert.equal(JSON.parse(readFileSync(path.join(b, 'package.json'), 'utf8')).type, 'commonjs');
});

// Tiny helper used by the "no helpers.js" test above. Avoids pulling in a
// separate import for a 5-line existence check.
function existsSyncFile(dir: string, name: string): boolean {
  try {
    readFileSync(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}
