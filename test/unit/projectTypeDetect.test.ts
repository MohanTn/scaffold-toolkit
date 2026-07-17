import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectProjectType } from '../../src/config/projectTypeDetect.js';

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), 'scaffold-detect-'));
}

test('detectProjectType finds dotnet from a .csproj file', () => {
  const dir = tmpRepo();
  writeFileSync(path.join(dir, 'App.csproj'), '<Project />');
  assert.equal(detectProjectType(dir), 'dotnet');
});

test('detectProjectType finds js-family from a react dependency in package.json', () => {
  const dir = tmpRepo();
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }));
  assert.equal(detectProjectType(dir), 'js-family');
});

test('detectProjectType finds go from go.mod', () => {
  const dir = tmpRepo();
  writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n');
  assert.equal(detectProjectType(dir), 'go');
});

test('detectProjectType finds python from pyproject.toml', () => {
  const dir = tmpRepo();
  writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "app"\n');
  assert.equal(detectProjectType(dir), 'python');
});

test('detectProjectType returns undefined on ambiguity (no recognizable markers)', () => {
  const dir = tmpRepo();
  assert.equal(detectProjectType(dir), undefined);
});
