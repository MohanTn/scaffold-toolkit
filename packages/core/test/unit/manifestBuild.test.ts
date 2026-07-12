import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignOptionPath, buildIntentManifest, parseFieldSpec } from '../../src/manifest/build.js';
import { ManifestValidationError } from '../../src/manifest/decode.js';

test('parseFieldSpec splits name:type and trims', () => {
  assert.deepEqual(parseFieldSpec('Amount:decimal'), { name: 'Amount', type: 'decimal' });
  assert.deepEqual(parseFieldSpec(' IssuedAt : DateTime '), { name: 'IssuedAt', type: 'DateTime' });
});

test('parseFieldSpec keeps generic types containing colons intact after the first', () => {
  assert.deepEqual(parseFieldSpec('Tags:List<string>'), { name: 'Tags', type: 'List<string>' });
});

test('parseFieldSpec rejects missing name or type', () => {
  assert.throws(() => parseFieldSpec('Amount'), /expected name:type/);
  assert.throws(() => parseFieldSpec(':decimal'), /expected name:type/);
  assert.throws(() => parseFieldSpec('Amount:'), /expected name:type/);
});

test('assignOptionPath nests dot paths and coerces booleans and numbers', () => {
  const options: Record<string, unknown> = {};
  assignOptionPath(options, 'database.provider=sqlite');
  assignOptionPath(options, 'database.pooling=true');
  assignOptionPath(options, 'retries=3');
  assert.deepEqual(options, { database: { provider: 'sqlite', pooling: true }, retries: 3 });
});

test('assignOptionPath keeps leading-zero and non-numeric strings verbatim', () => {
  const options: Record<string, unknown> = {};
  assignOptionPath(options, 'zip=01234');
  assignOptionPath(options, 'route=/api/invoices');
  assert.deepEqual(options, { zip: '01234', route: '/api/invoices' });
});

test('assignOptionPath rejects malformed assignments and non-object collisions', () => {
  const options: Record<string, unknown> = {};
  assert.throws(() => assignOptionPath(options, 'noequals'), /expected path=value/);
  assert.throws(() => assignOptionPath(options, '=value'), /expected path=value/);
  assert.throws(() => assignOptionPath(options, 'a..b=1'), /empty segment/);
  assignOptionPath(options, 'database=sqlite');
  assert.throws(() => assignOptionPath(options, 'database.provider=sqlite'), /non-object value/);
});

test('buildIntentManifest produces a schema-valid manifest', () => {
  const manifest = buildIntentManifest({
    targetStack: 'backend',
    entity: 'Invoice',
    fields: ['Amount:decimal', 'IssuedAt:DateTime'],
    options: ['rootNamespace=Acme.Billing', 'database.provider=sqlite'],
    inputs: [],
  });
  assert.deepEqual(manifest, {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity: 'Invoice',
    fields: [
      { name: 'Amount', type: 'decimal' },
      { name: 'IssuedAt', type: 'DateTime' },
    ],
    options: { rootNamespace: 'Acme.Billing', database: { provider: 'sqlite' } },
  });
});

test('buildIntentManifest omits entity, fields, and options when not given', () => {
  const manifest = buildIntentManifest({ targetStack: 'backend', fields: [], options: [], inputs: [] });
  assert.deepEqual(manifest, { manifestSchemaVersion: 1, targetStack: 'backend' });
});

test('buildIntentManifest surfaces schema violations', () => {
  assert.throws(
    () => buildIntentManifest({ targetStack: 'backend', entity: 'invoice', fields: [], options: [], inputs: [] }),
    ManifestValidationError,
  );
});

test('buildIntentManifest accepts --input assignments as flat top-level fields', () => {
  const manifest = buildIntentManifest({
    targetStack: 'module',
    fields: [],
    options: [],
    inputs: ['name=Billing'],
  });
  assert.deepEqual(manifest, {
    manifestSchemaVersion: 1,
    targetStack: 'module',
    name: 'Billing',
  });
});

test('buildIntentManifest coerces numeric and boolean input values', () => {
  const manifest = buildIntentManifest({
    targetStack: 'module',
    fields: [],
    options: [],
    inputs: ['count=3', 'enabled=true', 'disabled=false'],
  });
  assert.deepEqual(manifest, {
    manifestSchemaVersion: 1,
    targetStack: 'module',
    count: 3,
    enabled: true,
    disabled: false,
  });
});

test('buildIntentManifest keeps leading-zero and non-numeric input strings verbatim', () => {
  const manifest = buildIntentManifest({
    targetStack: 'module',
    fields: [],
    options: [],
    inputs: ['zip=01234', 'version=v1.0'],
  });
  assert.deepEqual(manifest, {
    manifestSchemaVersion: 1,
    targetStack: 'module',
    zip: '01234',
    version: 'v1.0',
  });
});

test('buildIntentManifest rejects --input with no equals sign', () => {
  assert.throws(
    () => buildIntentManifest({ targetStack: 'module', fields: [], options: [], inputs: ['noequals'] }),
    /expected name=value/,
  );
});

test('buildIntentManifest rejects --input with empty key', () => {
  assert.throws(
    () => buildIntentManifest({ targetStack: 'module', fields: [], options: [], inputs: ['=value'] }),
    /expected name=value|empty key/,
  );
});

test('buildIntentManifest rejects --input with reserved key collision', () => {
  const reserved = ['manifestSchemaVersion', 'targetStack', 'entity', 'fields', 'options'];
  for (const key of reserved) {
    assert.throws(
      () => buildIntentManifest({ targetStack: 'module', fields: [], options: [], inputs: [`${key}=value`] }),
      /reserved manifest key/,
    );
  }
});

test('buildIntentManifest combines --input with --entity, --field, and --option without cross-contamination', () => {
  const manifest = buildIntentManifest({
    targetStack: 'module',
    entity: 'Invoice',
    fields: ['Amount:decimal'],
    options: ['timezone=UTC'],
    inputs: ['name=Billing'],
  });
  assert.deepEqual(manifest, {
    manifestSchemaVersion: 1,
    targetStack: 'module',
    entity: 'Invoice',
    fields: [{ name: 'Amount', type: 'decimal' }],
    options: { timezone: 'UTC' },
    name: 'Billing',
  });
});
