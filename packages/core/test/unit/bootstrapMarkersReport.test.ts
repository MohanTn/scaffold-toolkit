import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBootstrapMarkersReport } from '../../src/bootstrapMarkers/bootstrapMarkersReport.js';
import type { BootstrapMarkersReport } from '../../src/bootstrapMarkers/bootstrapMarkersReport.js';

const sampleReport: BootstrapMarkersReport = {
  dryRun: false,
  placed: [
    { marker: 'GSM', file: 'Program.cs', packSlot: 'backend' },
    { marker: 'DI', file: 'Program.cs', packSlot: 'backend' },
  ],
  alreadyPresent: [{ marker: 'MIDDLEWARE', file: 'Program.cs', packSlot: 'backend' }],
  needsManual: [{ marker: 'DBSETS', file: 'src/Infrastructure/Persistence/AppDbContext.cs', packSlot: 'backend', reason: 'ambiguous class declaration' }],
  // An uncataloged pack version (e.g. a frontend pack) is reported here, not
  // in needsManual — there is nothing actionable the user could do about it.
  unsupportedPacks: [{ packSlot: 'frontend', version: 'tanstack-query', reason: 'pack version "tanstack-query" has no bootstrap-markers anchor catalog entry' }],
};

test('renderBootstrapMarkersReport JSON round-trips a multi-packSlot sample report to an equal object', () => {
  const rendered = renderBootstrapMarkersReport(sampleReport, 'json');
  const parsed = JSON.parse(rendered) as BootstrapMarkersReport;
  assert.deepEqual(parsed, sampleReport);
});

test('renderBootstrapMarkersReport TOON output contains every packSlot value, including an unsupportedPacks entry', () => {
  const rendered = renderBootstrapMarkersReport(sampleReport, 'toon');
  assert.match(rendered, /backend/);
  assert.match(rendered, /frontend/);
  assert.match(rendered, /GSM/);
  assert.match(rendered, /DBSETS/);
  assert.match(rendered, /tanstack-query/);
});

test('renderBootstrapMarkersReport produces different output for json vs toon formats', () => {
  const json = renderBootstrapMarkersReport(sampleReport, 'json');
  const toon = renderBootstrapMarkersReport(sampleReport, 'toon');
  assert.notEqual(json, toon);
});
