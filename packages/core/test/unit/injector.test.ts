import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { injectMarkers, InjectionRefusedError } from '../../src/generate/injector.js';
import type { InjectionRequest } from '../../src/generate/injector.js';
import { MarkerScanError } from '../../src/generate/markerScan.js';

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const cleanFile = ['before', '// SCAFFOLD:SCAFFOLD_DI:START', '// SCAFFOLD:SCAFFOLD_DI:END', 'after'].join('\n');

function request(overrides: Partial<InjectionRequest> = {}): InjectionRequest {
  return {
    marker: 'SCAFFOLD_DI',
    renderedContent: '    services.AddScoped<IInvoiceService, InvoiceService>();',
    hashTrailerPrefix: '// scaffold-hash:',
    position: 'before-end',
    ...overrides,
  };
}

test('injectMarkers writes new content into an empty marker block on first run', () => {
  const { content, outcomes } = injectMarkers('Program.cs', cleanFile, [request()], false);
  assert.equal(outcomes[0].action, 'created');
  assert.match(content, /services\.AddScoped<IInvoiceService, InvoiceService>\(\);/);
  assert.match(content, /\/\/ scaffold-hash:[0-9a-f]{64}/);
});

test('injectMarkers is idempotent: re-running with identical rendered content produces byte-identical output and action "unchanged"', () => {
  const first = injectMarkers('Program.cs', cleanFile, [request()], false);
  const second = injectMarkers('Program.cs', first.content, [request()], false);
  assert.equal(second.content, first.content);
  assert.equal(second.outcomes[0].action, 'unchanged');
});

test('injectMarkers refuses differing content on a non-empty block without --force', () => {
  const first = injectMarkers('Program.cs', cleanFile, [request()], false);
  const differentContent = request({ renderedContent: '    services.AddScoped<ICustomerService, CustomerService>();' });
  assert.throws(() => injectMarkers('Program.cs', first.content, [differentContent], false), InjectionRefusedError);
});

test('injectMarkers overwrites differing content on a non-empty block with --force', () => {
  const first = injectMarkers('Program.cs', cleanFile, [request()], false);
  const differentContent = request({ renderedContent: '    services.AddScoped<ICustomerService, CustomerService>();' });
  const second = injectMarkers('Program.cs', first.content, [differentContent], true);
  assert.equal(second.outcomes[0].action, 'updated');
  assert.match(second.content, /ICustomerService/);
  assert.doesNotMatch(second.content, /IInvoiceService/);
});

test('injectMarkers a hand-edited block (no hash trailer at all) is treated as non-empty differing content and refused without --force', () => {
  const handEdited = ['// SCAFFOLD:SCAFFOLD_DI:START', '    // a human wrote this by hand', '// SCAFFOLD:SCAFFOLD_DI:END'].join('\n');
  assert.throws(() => injectMarkers('Program.cs', handEdited, [request()], false), InjectionRefusedError);
});

test('injectMarkers hostile input: missing marker throws and does not return a result', () => {
  const noMarkerFile = 'nothing to see here';
  assert.throws(() => injectMarkers('Program.cs', noMarkerFile, [request()], false), MarkerScanError);
});

test('injectMarkers hostile input: duplicated marker throws citing both line numbers', () => {
  const duplicated = [
    '// SCAFFOLD:SCAFFOLD_DI:START',
    '// SCAFFOLD:SCAFFOLD_DI:START',
    '// SCAFFOLD:SCAFFOLD_DI:END',
  ].join('\n');
  assert.throws(() => injectMarkers('Program.cs', duplicated, [request()], false), (err: unknown) => {
    assert.ok(err instanceof MarkerScanError);
    assert.match(err.message, /Program\.cs:1,2/);
    return true;
  });
});

test('injectMarkers hostile input: one-sided marker throws citing file and line', () => {
  const oneSided = ['// SCAFFOLD:SCAFFOLD_DI:START', 'no end here'].join('\n');
  assert.throws(() => injectMarkers('Program.cs', oneSided, [request()], false), (err: unknown) => {
    assert.ok(err instanceof MarkerScanError);
    assert.match(err.message, /Program\.cs:1/);
    return true;
  });
});

test('injectMarkers single-pass rebuild: two independent markers in one file inject in either declared order without interfering with each other', () => {
  const twoMarkerFile = [
    '// SCAFFOLD:SCAFFOLD_DI:START',
    '// SCAFFOLD:SCAFFOLD_DI:END',
    '// SCAFFOLD:SCAFFOLD_ROUTES:START',
    '// SCAFFOLD:SCAFFOLD_ROUTES:END',
  ].join('\n');

  const diRequest = request({ renderedContent: '    services.AddScoped<IInvoiceService, InvoiceService>();' });
  const routesRequest: InjectionRequest = {
    marker: 'SCAFFOLD_ROUTES',
    renderedContent: '    app.MapGet("/api/invoices", () => Results.Ok());',
    hashTrailerPrefix: '// scaffold-hash:',
    position: 'before-end',
  };

  const forward = injectMarkers('Program.cs', twoMarkerFile, [diRequest, routesRequest], false);
  const reversed = injectMarkers('Program.cs', twoMarkerFile, [routesRequest, diRequest], false);

  assert.equal(forward.content, reversed.content, 'declaration order must not affect the rebuilt file content');
  assert.match(forward.content, /IInvoiceService/);
  assert.match(forward.content, /\/api\/invoices/);

  // Each marker's hash trailer is scoped to its own block, not shared per-file.
  const diHash = sha(diRequest.renderedContent);
  const routesHash = sha(routesRequest.renderedContent);
  assert.match(forward.content, new RegExp(`// scaffold-hash:${diHash}`));
  assert.match(forward.content, new RegExp(`// scaffold-hash:${routesHash}`));
  assert.notEqual(diHash, routesHash);
});
