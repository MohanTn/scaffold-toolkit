import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeToon, decodeToon } from '../../src/toon/codec.js';

test('toon round-trip: intent-manifest-shaped object', () => {
  const manifest = {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity: 'Invoice',
    fields: [
      { name: 'id', type: 'guid' },
      { name: 'amount', type: 'decimal' },
    ],
    options: { route: '/api/invoices' },
  };
  const encoded = encodeToon(manifest);
  const decoded = decodeToon(encoded);
  assert.deepEqual(decoded, manifest);
});

test('toon round-trip: report-shaped object with nested arrays of objects', () => {
  const report = {
    dryRun: false,
    changesetId: '1234567890123-000001',
    created: [{ file: 'src/Endpoints/InvoiceEndpoint.cs', mode: 'create', skipped: false }],
    injected: [
      { file: 'Program.cs', marker: 'SCAFFOLD_DI', action: 'created' },
      { file: 'Program.cs', marker: 'SCAFFOLD_ROUTES', action: 'created' },
    ],
    aiImplementation: [
      { file: 'src/Endpoints/InvoiceEndpoint.cs', startLine: 5, endLine: 7, content: '        // TODO: implement Invoice handling', empty: false },
    ],
  };
  const encoded = encodeToon(report);
  const decoded = decodeToon(encoded);
  assert.deepEqual(decoded, report);
});

test('toon round-trip: empty arrays', () => {
  const value = { created: [], injected: [], aiImplementation: [] };
  assert.deepEqual(decodeToon(encodeToon(value)), value);
});
