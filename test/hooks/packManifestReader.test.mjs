import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mapFileToTemplate,
  getStandardsForFile,
  formatStandardsGuidance,
  getEnforcementMode,
} from '../../hooks/packManifestReader.mjs';

function tmpRepo() {
  return mkdtempSync(path.join(tmpdir(), 'scaffold-cc-conf-'));
}

test('getEnforcementMode: defaults to "gate" when .scaffold/conf.json is absent', () => {
  assert.strictEqual(getEnforcementMode(tmpRepo()), 'gate');
});

test('getEnforcementMode: "nudge" when explicitly configured', () => {
  const dir = tmpRepo();
  mkdirSync(path.join(dir, '.scaffold'), { recursive: true });
  writeFileSync(path.join(dir, '.scaffold', 'conf.json'), JSON.stringify({ editEnforcement: 'nudge' }));
  assert.strictEqual(getEnforcementMode(dir), 'nudge');
});

test('getEnforcementMode: falls back to "gate" for an unrecognized value', () => {
  const dir = tmpRepo();
  mkdirSync(path.join(dir, '.scaffold'), { recursive: true });
  writeFileSync(path.join(dir, '.scaffold', 'conf.json'), JSON.stringify({ editEnforcement: 'yolo' }));
  assert.strictEqual(getEnforcementMode(dir), 'gate');
});

test('getEnforcementMode: falls back to "gate" on malformed JSON', () => {
  const dir = tmpRepo();
  mkdirSync(path.join(dir, '.scaffold'), { recursive: true });
  writeFileSync(path.join(dir, '.scaffold', 'conf.json'), '{ not json');
  assert.strictEqual(getEnforcementMode(dir), 'gate');
});

test('mapFileToTemplate: exact pattern match', () => {
  const manifest = {
    targets: [
      { output: '{{entity}}Repository.cs', template: 'EntityRepository.cs.hbs' },
      { output: 'Create{{entity}}Command.cs', template: 'CreateEntityCommand.cs.hbs' },
    ],
  };

  const result = mapFileToTemplate('OrderRepository.cs', manifest);
  assert.strictEqual(result, 'EntityRepository.cs.hbs');
});

test('mapFileToTemplate: returns null when no match', () => {
  const manifest = {
    targets: [
      { output: '{{entity}}Repository.cs', template: 'EntityRepository.cs.hbs' },
    ],
  };

  const result = mapFileToTemplate('SomeRandomFile.txt', manifest);
  assert.strictEqual(result, null);
});

test('mapFileToTemplate: prefers more specific matches', () => {
  const manifest = {
    targets: [
      { output: '{{entity}}Handler.cs', template: 'GenericHandler.cs.hbs' },
      { output: 'Create{{entity}}CommandHandler.cs', template: 'CreateEntityCommandHandler.cs.hbs' },
    ],
  };

  const result = mapFileToTemplate('CreateOrderCommandHandler.cs', manifest);
  // Should prefer the more specific pattern (fewer {{ }})
  assert.strictEqual(result, 'CreateEntityCommandHandler.cs.hbs');
});

test('getStandardsForFile: exact template match', () => {
  const manifest = {
    codingStandards: {
      'EntityRepository.cs.hbs': {
        fileType: 'repository',
        rules: ['Use transactions', 'Use using blocks'],
      },
    },
    targets: [
      { output: '{{entity}}Repository.cs', template: 'EntityRepository.cs.hbs' },
    ],
  };

  const result = getStandardsForFile('OrderRepository.cs', manifest);
  // getStandardsForFile should find the standards by mapping OrderRepository.cs to EntityRepository.cs.hbs template
  assert.ok(result, 'Should find standards for OrderRepository.cs');
  assert.strictEqual(result.fileType, 'repository');
  assert.strictEqual(result.rules.length, 2);
  assert.strictEqual(result.rules[0], 'Use transactions');
});

test('getStandardsForFile: returns null when no match', () => {
  const manifest = {
    codingStandards: {
      'EntityRepository.cs.hbs': { fileType: 'repository', rules: [] },
    },
  };

  const result = getStandardsForFile('UnknownFile.cs', manifest);
  assert.strictEqual(result, null);
});

test('getStandardsForFile: pattern match with wildcard', () => {
  const manifest = {
    codingStandards: {
      '*Handler.cs': {
        fileType: 'handler',
        rules: ['Validate before load', 'Return explicit Result<T>'],
      },
    },
  };

  const result = getStandardsForFile('CreateOrderHandler.cs', manifest);
  assert.ok(result, 'Should match *Handler.cs pattern');
  assert.strictEqual(result.fileType, 'handler');
});

test('getStandardsForFile: missing codingStandards field returns null', () => {
  const manifest = {
    targets: [{ output: '{{entity}}Handler.cs', template: 'Handler.hbs' }],
    // No codingStandards field
  };

  const result = getStandardsForFile('OrderHandler.cs', manifest);
  assert.strictEqual(result, null);
});

test('formatStandardsGuidance: formats guidance string with rules', () => {
  const standards = {
    fileType: 'handler',
    rules: ['Decompose >150 LOC', 'Validate before load', 'Use async/await'],
  };

  const result = formatStandardsGuidance(standards, 'CreateOrderHandler.cs');
  assert.ok(result.includes('Coding standards for handler'));
  assert.ok(result.includes('CreateOrderHandler.cs'));
  assert.ok(result.includes('Decompose >150 LOC'));
  assert.ok(result.includes('Validate before load'));
  assert.ok(result.includes('class-level AI_IMPLEMENTATION marker'));
});

test('formatStandardsGuidance: includes block line range when provided', () => {
  const standards = { fileType: 'repository', rules: ['Use transactions'] };
  const blockLines = { start: 10, end: 25 };

  const result = formatStandardsGuidance(standards, 'OrderRepository.cs', blockLines);
  assert.ok(result.includes('lines 10-25'));
});

test('formatStandardsGuidance: handles missing rules gracefully', () => {
  const standards = { fileType: 'dto' };
  const result = formatStandardsGuidance(standards, 'OrderDto.cs');
  assert.ok(result.includes('Coding standards for dto'));
});

test('resolvePackVersionDir: resolves a path pack version dir off disk', async () => {
  const { resolvePackVersionDir } = await import('../../hooks/packManifestReader.mjs');
  const dir = tmpRepo();
  mkdirSync(path.join(dir, 'mypack', 'v1'), { recursive: true });
  writeFileSync(path.join(dir, 'mypack', 'v1', 'manifest.templates.json'), '{}');

  const resolved = resolvePackVersionDir(dir, { path: 'mypack', version: 'v1' });
  assert.strictEqual(resolved, path.join(dir, 'mypack', 'v1'));
  assert.strictEqual(resolvePackVersionDir(dir, { path: 'mypack', version: 'v2' }), null);
  assert.strictEqual(resolvePackVersionDir(dir, { version: 'v1' }), null);
});

test('resolvePackVersionDir: finds a url pack in the .scaffold/cache layout', async () => {
  const { resolvePackVersionDir } = await import('../../hooks/packManifestReader.mjs');
  const dir = tmpRepo();
  const versionDir = path.join(dir, '.scaffold', 'cache', 'someurlhash', 'abc123', 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(path.join(versionDir, 'manifest.templates.json'), '{}');

  const resolved = resolvePackVersionDir(dir, { url: 'https://example.com/pack.git', pinnedSha: 'abc123', version: 'v1' });
  assert.strictEqual(resolved, versionDir);
  assert.strictEqual(
    resolvePackVersionDir(dir, { url: 'https://example.com/pack.git', pinnedSha: 'missing', version: 'v1' }),
    null,
  );
});

test('resolvePack: adoptedPaths exact repo-relative match wins', async () => {
  const { resolvePack } = await import('../../hooks/packManifestReader.mjs');
  const dir = tmpRepo();
  mkdirSync(path.join(dir, '.scaffold'), { recursive: true });
  mkdirSync(path.join(dir, 'mypack', 'v1'), { recursive: true });
  writeFileSync(path.join(dir, 'mypack', 'v1', 'manifest.templates.json'), '{}');
  writeFileSync(
    path.join(dir, '.scaffold', 'config.json'),
    JSON.stringify({
      projectType: 'dotnet',
      packs: {
        backend: {
          path: 'mypack',
          version: 'v1',
          adoptedPaths: { 'target:Program.cs.hbs': 'src/Api/Program.cs' },
        },
      },
    }),
  );

  const hit = resolvePack(dir, path.join(dir, 'src', 'Api', 'Program.cs'));
  assert.ok(hit, 'adopted file should resolve to its pack');
  assert.strictEqual(hit.packName, 'backend');
  assert.strictEqual(hit.packVersion, 'v1');
  assert.strictEqual(hit.packPath, path.join(dir, 'mypack', 'v1'));

  assert.strictEqual(resolvePack(dir, path.join(dir, 'src', 'Api', 'Other.cs')), null);
});

test('resolvePack: generated file resolves via descriptor target pattern', async () => {
  const { resolvePack } = await import('../../hooks/packManifestReader.mjs');
  const dir = tmpRepo();
  mkdirSync(path.join(dir, '.scaffold'), { recursive: true });
  mkdirSync(path.join(dir, 'mypack', 'v1'), { recursive: true });
  writeFileSync(
    path.join(dir, 'mypack', 'v1', 'manifest.templates.json'),
    JSON.stringify({
      targets: [{ output: '{{entity}}Repository.cs', template: 'EntityRepository.cs.hbs' }],
    }),
  );
  writeFileSync(
    path.join(dir, '.scaffold', 'config.json'),
    JSON.stringify({ projectType: 'dotnet', packs: { backend: { path: 'mypack', version: 'v1' } } }),
  );

  const hit = resolvePack(dir, path.join(dir, 'src', 'OrderRepository.cs'));
  assert.ok(hit, 'generated file should resolve via target pattern');
  assert.strictEqual(hit.packName, 'backend');
});

test('resolveScaffoldInvocation: returns a runnable command shape', async () => {
  const { resolveScaffoldInvocation } = await import('../../hooks/packManifestReader.mjs');
  const invocation = resolveScaffoldInvocation();
  assert.ok(typeof invocation.command === 'string' && invocation.command.length > 0);
  assert.ok(Array.isArray(invocation.prefixArgs));
  if (invocation.prefixArgs.length > 0) {
    assert.ok(invocation.prefixArgs[0].endsWith(path.join('dist', 'cli.js')));
  } else {
    assert.strictEqual(invocation.command, 'scaffold');
  }
});
