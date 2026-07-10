import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, ManifestValidationError } from '../../src/manifest/decode.js';

const validManifest = {
  manifestSchemaVersion: 1,
  targetStack: 'backend',
  entity: 'Invoice',
  fields: [{ name: 'id', type: 'guid' }],
};

test('validateManifest accepts a valid manifest and passes options through untouched', () => {
  const withOptions = { ...validManifest, options: { route: '/api/invoices', anythingElse: 42 } };
  const result = validateManifest(withOptions);
  assert.deepEqual(result, withOptions);
});

test('validateManifest rejects a missing required field', () => {
  const missingEntity: Record<string, unknown> = { ...validManifest };
  delete missingEntity.entity;
  assert.throws(() => validateManifest(missingEntity), ManifestValidationError);
});

test('validateManifest rejects an entity name that is not PascalCase', () => {
  assert.throws(() => validateManifest({ ...validManifest, entity: 'invoice' }), ManifestValidationError);
});

test('validateManifest rejects an empty fields array', () => {
  assert.throws(() => validateManifest({ ...validManifest, fields: [] }), ManifestValidationError);
});

test('validateManifest rejects a field missing "type"', () => {
  assert.throws(() => validateManifest({ ...validManifest, fields: [{ name: 'id' }] }), ManifestValidationError);
});
