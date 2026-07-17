import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, configPath, ConfigValidationError } from '../../src/config/loader.js';

function writeRawConfig(dir: string, data: unknown): void {
  const file = configPath(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

test('saveConfig then loadConfig round-trips the packs map and provenance', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  const config = {
    projectType: 'dotnet',
    packs: { backend: { url: 'https://example.com/pack.git', version: 'v10-minimal-api', pinnedSha: 'abc123' } },
    provenance: { 'Program.cs': { packUrl: 'https://example.com/pack.git', packVersion: 'v10-minimal-api', resolvedSha: 'abc123' } },
  };
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir), config);
});

test('loadConfig throws a clear error when .scaffold/config.json is missing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  assert.throws(() => loadConfig(dir), /run "scaffold init"/);
});

test('loadConfig rejects a config with an unknown top-level field', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  writeRawConfig(dir, { projectType: 'dotnet', packs: {}, templatePack: 'legacy-shape' });
  assert.throws(() => loadConfig(dir), ConfigValidationError);
});

test('loadConfig rejects a pack entry with neither "url" nor "path"', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  writeRawConfig(dir, { projectType: 'dotnet', packs: { backend: { version: 'v1' } } });
  assert.throws(() => loadConfig(dir), ConfigValidationError);
});

test('loadConfig rejects a pack entry with both "url" and "path"', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  writeRawConfig(dir, { projectType: 'dotnet', packs: { backend: { url: 'https://example.com/pack.git', path: 'templates/templates-dotnet', version: 'v1' } } });
  assert.throws(() => loadConfig(dir), ConfigValidationError);
});

test('saveConfig then loadConfig round-trips a path-based pack entry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  const config = {
    projectType: 'dotnet',
    packs: { backend: { path: 'templates/templates-dotnet', version: 'v8-controller' } },
  };
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir), config);
});

test('saveConfig then loadConfig round-trips a manually-declared capabilityFlags map, keyed like adoptedPaths', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  const config = {
    projectType: 'dotnet',
    packs: {
      backend: {
        path: 'templates/templates-dotnet',
        version: 'v8-controller',
        capabilityFlags: { 'target:src/Controllers/{{entity}}Controller.cs::Order': 'CRUD' as const },
      },
    },
  };
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir), config);
});

test('loadConfig rejects a capabilityFlags value outside READ-ONLY/WRITE-ONLY/CRUD', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  writeRawConfig(dir, {
    projectType: 'dotnet',
    packs: { backend: { path: 'templates/templates-dotnet', version: 'v1', capabilityFlags: { 'target:Foo.cs': 'DELETE-ONLY' } } },
  });
  assert.throws(() => loadConfig(dir), ConfigValidationError);
});

test('saveConfig then loadConfig round-trips a free-form pack defaults object', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-config-'));
  const config = {
    projectType: 'dotnet',
    packs: {
      backend: {
        path: 'templates/templates-dotnet',
        version: 'csharp-enterprise',
        defaults: { options: { combine: true, database: { scope: 'Tenant' } } },
      },
    },
  };
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir), config);
});
