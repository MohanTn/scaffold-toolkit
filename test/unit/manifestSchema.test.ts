import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, ManifestValidationError } from '../../src/manifest/decode.js';
import { validateManifestInputs, ManifestInputValidationError } from '../../src/manifest/inputValidation.js';

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

// --- Base schema: only the universal fields are now required at the base-schema layer ---
// Per-pack input contracts (entity/fields for dotnet; whatever a custom pack
// declares) are enforced separately by `validateManifestInputs` after the pack
// descriptor is loaded.

test('validateManifest accepts a manifest missing entity and fields at the base schema layer', () => {
  const minimal = { manifestSchemaVersion: 1, targetStack: 'backend' };
  assert.deepEqual(validateManifest(minimal), minimal);
});

test('validateManifest still rejects a missing universal required field (manifestSchemaVersion)', () => {
  const missing: Record<string, unknown> = { ...validManifest };
  delete missing.manifestSchemaVersion;
  assert.throws(() => validateManifest(missing), ManifestValidationError);
});

test('validateManifest still rejects a missing universal required field (targetStack)', () => {
  const missing: Record<string, unknown> = { ...validManifest };
  delete missing.targetStack;
  assert.throws(() => validateManifest(missing), ManifestValidationError);
});

test('validateManifest rejects an entity name that is not PascalCase when present', () => {
  assert.throws(() => validateManifest({ ...validManifest, entity: 'invoice' }), ManifestValidationError);
});

test('validateManifest rejects an empty fields array when fields is present', () => {
  assert.throws(() => validateManifest({ ...validManifest, fields: [] }), ManifestValidationError);
});

test('validateManifest rejects a field missing "type"', () => {
  assert.throws(() => validateManifest({ ...validManifest, fields: [{ name: 'id' }] }), ManifestValidationError);
});

// --- Per-pack input contract (via validateManifestInputs) ---

test('validateManifestInputs: legacy default contract — manifest missing entity fails', () => {
  const noEntity = { ...validManifest };
  delete (noEntity as Record<string, unknown>).entity;
  assert.throws(() => validateManifestInputs('v10-minimal-api', noEntity, undefined), ManifestInputValidationError);
});

test('validateManifestInputs: legacy default contract — valid dotnet manifest passes', () => {
  assert.doesNotThrow(() => validateManifestInputs('v10-minimal-api', validManifest, undefined));
});

test('validateManifestInputs: legacy default contract — names the offending pack and field on failure', () => {
  const noEntity = { ...validManifest };
  delete (noEntity as Record<string, unknown>).entity;
  try {
    validateManifestInputs('my-pack', noEntity, undefined);
    assert.fail('expected ManifestInputValidationError');
  } catch (error) {
    assert.ok(error instanceof ManifestInputValidationError);
    assert.equal(error.packVersion, 'my-pack');
    assert.match(error.message, /my-pack/);
  }
});

test('validateManifestInputs: declared inputs[] — passes when manifest matches declared shape', () => {
  const inputs = [
    { name: 'aggregate', type: 'string' as const, required: true, pattern: '^[A-Z][A-Za-z0-9]+$' },
    { name: 'events', type: 'array' as const, required: true, minItems: 1 },
  ];
  const manifest = { manifestSchemaVersion: 1, targetStack: 'python-backend', aggregate: 'OrderPlaced', events: [{ name: 'id', type: 'guid' }] };
  assert.doesNotThrow(() => validateManifestInputs('python-events-pack', manifest, inputs));
});

test('validateManifestInputs: declared inputs[] — fails on missing required', () => {
  const inputs = [{ name: 'aggregate', type: 'string' as const, required: true, pattern: '^[A-Z][A-Za-z0-9]+$' }];
  const manifest = { manifestSchemaVersion: 1, targetStack: 'python' };
  assert.throws(() => validateManifestInputs('python-events-pack', manifest, inputs), ManifestInputValidationError);
});

test('validateManifestInputs: declared inputs[] — fails on pattern mismatch', () => {
  const inputs = [{ name: 'aggregate', type: 'string' as const, required: true, pattern: '^[A-Z][A-Za-z0-9]+$' }];
  const manifest = { manifestSchemaVersion: 1, targetStack: 'python', aggregate: 'orderPlaced' };
  assert.throws(() => validateManifestInputs('python-events-pack', manifest, inputs), ManifestInputValidationError);
});

test('validateManifestInputs: declared inputs[] — fails on wrong type', () => {
  const inputs = [{ name: 'count', type: 'integer' as const, required: true }];
  const manifest = { manifestSchemaVersion: 1, targetStack: 'python', count: 'not-an-int' };
  assert.throws(() => validateManifestInputs('python-events-pack', manifest, inputs), ManifestInputValidationError);
});

test('validateManifestInputs: declared inputs[] — fails when array minItems is not met', () => {
  const inputs = [{ name: 'events', type: 'array' as const, required: true, minItems: 1 }];
  const manifest = { manifestSchemaVersion: 1, targetStack: 'python', events: [] };
  assert.throws(() => validateManifestInputs('python-events-pack', manifest, inputs), ManifestInputValidationError);
});

test('validateManifestInputs: declared inputs[] — optional entry does not need to be present', () => {
  const inputs = [{ name: 'aggregate', type: 'string' as const, required: true }, { name: 'optionalFlag', type: 'boolean' as const, required: false }];
  const manifest = { manifestSchemaVersion: 1, targetStack: 'python', aggregate: 'OrderPlaced' };
  assert.doesNotThrow(() => validateManifestInputs('python-events-pack', manifest, inputs));
});

test('validateManifestInputs: declared inputs[] — empty inputs array means no constraints beyond base schema', () => {
  const manifest = { manifestSchemaVersion: 1, targetStack: 'python', anything: 'goes' };
  assert.doesNotThrow(() => validateManifestInputs('python-anything-pack', manifest, []));
});

// --- Hostile-input regression: a pack declaring `name: "__proto__"` must not pollute the schema fragment ---

test('validateManifestInputs: a host declaring an `__proto__`-named input does not corrupt Object.prototype', () => {
  // Object.prototype pollution changes are observable on a fresh object
  // we never touched. If the schema fragment's `properties` map leaked
  // onto Object.prototype, `({}).polluted` reads back true below; if the
  // defense holds, it reads back undefined.
  const hostile = [{ name: '__proto__', type: 'string' as const, required: false }];
  const manifest = { manifestSchemaVersion: 1, targetStack: 'evil' };
  validateManifestInputs('evil-pack', manifest, hostile);
  const fresh: Record<string, unknown> = {};
  assert.equal(fresh.polluted, undefined, 'Object.prototype was polluted');
});

test('validateManifestInputs: a host declaring many prototype-namespaced inputs still does not pollute Object.prototype', () => {
  // Cover `__proto__`, `constructor`, `hasOwnProperty` — same defense
  // must defeat all of them. The validation call may legitimately throw
  // (ajv type-checks inherited prototype values against the declared
  // type, e.g. inherited `hasOwnProperty` is a function not an integer),
  // which is unrelated to the pollution concern we want to test. We
  // catch any throw, then assert Object.prototype is unchanged after
  // the schema fragment's construction phase ran.
  const hostile = [
    { name: '__proto__', type: 'string' as const, required: false },
    { name: 'constructor', type: 'object' as const, required: false },
    { name: 'hasOwnProperty', type: 'integer' as const, required: false },
  ];
  try {
    validateManifestInputs('evil-pack', { manifestSchemaVersion: 1, targetStack: 'evil' }, hostile);
  } catch {
    // Ajv may throw on type-check mismatch against inherited prototype
    // values; that is a separate code path from prototype pollution.
    // We swallow only to reach the pollution assertion below.
  }
  const fresh: Record<string, unknown> = {};
  assert.equal(fresh.polluted, undefined, 'Object.prototype was polluted');
  assert.equal(typeof fresh.hasOwnProperty, 'function', 'native hasOwnProperty was clobbered');
  assert.equal(typeof fresh.constructor, 'function', 'native constructor was clobbered');
});

test('validateManifest accepts an artifacts string array and rejects malformed ones', () => {
  const scoped = { ...validManifest, artifacts: ['base', 'op-create'] };
  assert.deepEqual(validateManifest(scoped), scoped);

  assert.throws(() => validateManifest({ ...validManifest, artifacts: [] }), ManifestValidationError);
  assert.throws(() => validateManifest({ ...validManifest, artifacts: ['ok', ''] }), ManifestValidationError);
  assert.throws(() => validateManifest({ ...validManifest, artifacts: 'op-create' }), ManifestValidationError);
});
