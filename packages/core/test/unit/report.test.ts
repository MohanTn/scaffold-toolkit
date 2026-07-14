import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReportAsDoc } from '../../src/generate/report.js';
import type { GenerateReport } from '../../src/generate/report.js';

const sampleReport: GenerateReport = {
  dryRun: true,
  entity: 'Invoice',
  options: { route: '/api/invoices' },
  created: [{ file: 'src/Endpoints/InvoiceEndpoint.cs', mode: 'create', skipped: false }],
  injected: [{ file: 'Program.cs', marker: 'SCAFFOLD_DI', action: 'created' }],
  aiImplementation: [{ file: 'src/Endpoints/InvoiceEndpoint.cs', startLine: 5, endLine: 7, content: '', empty: true, required: false }],
};

test('renderReportAsDoc: a dry-run report renders a preflight header, entity/options, files, and pending AI_IMPLEMENTATION blocks', () => {
  const doc = renderReportAsDoc(sampleReport);
  assert.match(doc, /^scaffold generate — preflight \(dry-run, nothing written\)/);
  assert.match(doc, /Entity: Invoice/);
  assert.match(doc, /route: "\/api\/invoices"/);
  assert.match(doc, /Files to create \(1\):/);
  assert.match(doc, /src\/Endpoints\/InvoiceEndpoint\.cs \(mode: create\)/);
  assert.match(doc, /Files to inject \(1\):/);
  assert.match(doc, /Program\.cs \[SCAFFOLD_DI\]: created/);
  assert.match(doc, /AI_IMPLEMENTATION blocks left pending \(1\):/);
  assert.match(doc, /src\/Endpoints\/InvoiceEndpoint\.cs:5-7 \(required: false, empty: true\)/);
});

test('renderReportAsDoc: a non-dry-run report gets the "report" header instead of "preflight"', () => {
  const doc = renderReportAsDoc({ ...sampleReport, dryRun: false });
  assert.match(doc, /^scaffold generate — report/);
});

test('renderReportAsDoc: zero created/injected/pending files render explicit "(none)" rather than an empty section', () => {
  const doc = renderReportAsDoc({ dryRun: true, created: [], injected: [], aiImplementation: [], options: {} });
  assert.match(doc, /Files to create \(0\):\n {2}\(none\)/);
  assert.match(doc, /Files to inject \(0\):\n {2}\(none\)/);
  assert.match(doc, /AI_IMPLEMENTATION blocks left pending \(0\):\n {2}\(none\)/);
});
