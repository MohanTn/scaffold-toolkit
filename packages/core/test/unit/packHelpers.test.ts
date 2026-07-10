import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Handlebars from 'handlebars';
import { registerPackHelpers } from '../../src/generate/packHelpers.js';

test('registerPackHelpers is a no-op when the pack ships no helpers.js', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-pack-helpers-'));
  assert.doesNotThrow(() => registerPackHelpers(dir));
});

test('registerPackHelpers loads a pack-local helpers.js and makes its helper usable in a template', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-pack-helpers-'));
  writeFileSync(
    path.join(dir, 'helpers.js'),
    `module.exports = { register(handlebars) {
      handlebars.registerHelper('shout', (s) => String(s).toUpperCase() + '!');
    } };`,
  );

  registerPackHelpers(dir);

  const output = Handlebars.compile('{{shout entity}}', { noEscape: true })({ entity: 'invoice' });
  assert.equal(output, 'INVOICE!');
});

test('registerPackHelpers throws a clear error when helpers.js does not export a register function', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-pack-helpers-'));
  writeFileSync(path.join(dir, 'helpers.js'), `module.exports = { register: 'not-a-function' };`);

  assert.throws(() => registerPackHelpers(dir), /must export a "register\(handlebars\)" function/);
});

test('registerPackHelpers re-reads helpers.js on every call instead of using a stale require cache', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-pack-helpers-'));
  const helpersPath = path.join(dir, 'helpers.js');

  writeFileSync(helpersPath, `module.exports = { register(h) { h.registerHelper('versioned', () => 'v1'); } };`);
  registerPackHelpers(dir);
  assert.equal(Handlebars.compile('{{versioned}}')({}), 'v1');

  writeFileSync(helpersPath, `module.exports = { register(h) { h.registerHelper('versioned', () => 'v2'); } };`);
  registerPackHelpers(dir);
  assert.equal(Handlebars.compile('{{versioned}}')({}), 'v2');
});
