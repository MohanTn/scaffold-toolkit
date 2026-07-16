import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { isMainModule } from '../hooks/isMainModule.mjs';

test('isMainModule is false when process.argv[1] is unset', () => {
  const savedArgv1 = process.argv[1];
  process.argv[1] = undefined;
  try {
    assert.equal(isMainModule(import.meta.url), false);
  } finally {
    process.argv[1] = savedArgv1;
  }
});

test('isMainModule is true when this test file itself is treated as the entry point', () => {
  const savedArgv1 = process.argv[1];
  process.argv[1] = new URL(import.meta.url).pathname;
  try {
    assert.equal(isMainModule(import.meta.url), true);
  } finally {
    process.argv[1] = savedArgv1;
  }
});

test('isMainModule is true when invoked through a symlink to the real script (the actual dotfiles topology)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-cc-symlink-'));
  const real = path.join(dir, 'real-entry.mjs');
  const link = path.join(dir, 'link-entry.mjs');
  writeFileSync(
    real,
    `import { isMainModule } from ${JSON.stringify(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'hooks', 'isMainModule.mjs'))};\n` +
      `if (isMainModule(import.meta.url)) { console.log('MAIN'); } else { console.log('NOT_MAIN'); }\n`,
  );
  symlinkSync(real, link);

  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, [link], (err, out) => (err ? reject(err) : resolve(out)));
    });
    assert.equal(stdout.trim(), 'MAIN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
