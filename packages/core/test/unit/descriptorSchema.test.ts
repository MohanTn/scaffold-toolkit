import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateDescriptor, loadDescriptor, DescriptorValidationError, DescriptorRequiresMismatchError } from '../../src/descriptor/load.js';

function baseDescriptor() {
  return {
    descriptorSchemaVersion: 2,
    packVersion: 'v10-minimal-api',
    requires: { scaffoldCli: '>=1.0.0 <2.0.0' },
    targets: [{ output: 'src/Endpoints/{{entity}}Endpoint.cs', template: 'Endpoint.cs.hbs', mode: 'create' }],
    injections: [
      { file: 'Program.cs', marker: 'SCAFFOLD_DI', template: 'di-registration.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' },
    ],
  };
}

test('validateDescriptor accepts a well-formed v2 descriptor and allows unknown top-level fields', () => {
  const descriptor = { ...baseDescriptor(), someFutureField: 'ok' };
  assert.deepEqual(validateDescriptor(descriptor), descriptor);
});

test('validateDescriptor rejects an unknown field inside a targets[] entry', () => {
  const descriptor = baseDescriptor();
  (descriptor.targets[0] as Record<string, unknown>).typoField = 'oops';
  assert.throws(() => validateDescriptor(descriptor), DescriptorValidationError);
});

test('validateDescriptor rejects an unknown field inside an injections[] entry', () => {
  const descriptor = baseDescriptor();
  (descriptor.injections[0] as Record<string, unknown>).typoField = 'oops';
  assert.throws(() => validateDescriptor(descriptor), DescriptorValidationError);
});

test('validateDescriptor rejects a marker starting with the reserved AI_IMPLEMENTATION namespace', () => {
  const descriptor = baseDescriptor();
  descriptor.injections[0].marker = 'AI_IMPLEMENTATION_EXTRA';
  assert.throws(() => validateDescriptor(descriptor), DescriptorValidationError);
});

test('validateDescriptor rejects an invalid mode value', () => {
  const descriptor = baseDescriptor();
  (descriptor.targets[0] as { mode: string }).mode = 'delete';
  assert.throws(() => validateDescriptor(descriptor), DescriptorValidationError);
});

test('loadDescriptor passes when the installed CLI version satisfies requires.scaffoldCli', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-descriptor-'));
  const file = path.join(dir, 'manifest.templates.json');
  writeFileSync(file, JSON.stringify(baseDescriptor()));
  const descriptor = loadDescriptor(file, '1.2.3');
  assert.equal(descriptor.packVersion, 'v10-minimal-api');
});

test('loadDescriptor throws DescriptorRequiresMismatchError when the installed CLI version is outside requires.scaffoldCli', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-descriptor-'));
  const file = path.join(dir, 'manifest.templates.json');
  writeFileSync(file, JSON.stringify(baseDescriptor()));
  assert.throws(() => loadDescriptor(file, '2.5.0'), DescriptorRequiresMismatchError);
});
