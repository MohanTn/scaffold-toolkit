/**
 * Pure tests for metrics.mjs — no live API calls. Exercises the extractor
 * against a checked-in recorded sample `claude -p --output-format json`
 * blob (test/fixtures/sample-claude-result.json), built from the plan's
 * documented widely-known result shape, NOT a payload captured from a real
 * call this session (see metrics.mjs's own header comment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMetrics, totalTokens, formatMetricsSummary } from '../metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'sample-claude-result.json'), 'utf8'));

test('extractMetrics pulls cost, token usage, duration, and turn count out of the sample result', () => {
  const metrics = extractMetrics(SAMPLE);
  assert.equal(metrics.costUsd, 0.3821);
  assert.equal(metrics.inputTokens, 1520);
  assert.equal(metrics.outputTokens, 3105);
  assert.equal(metrics.durationMs, 42317);
  assert.equal(metrics.numTurns, 6);
});

test('extractMetrics returns null (not 0 or undefined) for every field when given an empty object', () => {
  const metrics = extractMetrics({});
  assert.deepEqual(metrics, { costUsd: null, inputTokens: null, outputTokens: null, durationMs: null, numTurns: null });
});

test('extractMetrics tolerates a missing usage object entirely', () => {
  const metrics = extractMetrics({ total_cost_usd: 0.5 });
  assert.equal(metrics.costUsd, 0.5);
  assert.equal(metrics.inputTokens, null);
  assert.equal(metrics.outputTokens, null);
});

test('totalTokens sums input and output tokens', () => {
  const metrics = extractMetrics(SAMPLE);
  assert.equal(totalTokens(metrics), 1520 + 3105);
});

test('totalTokens is null, not a partial sum, when either half is missing', () => {
  assert.equal(totalTokens({ inputTokens: 100, outputTokens: null }), null);
  assert.equal(totalTokens({ inputTokens: null, outputTokens: 100 }), null);
});

test('formatMetricsSummary renders a PASS build result without an error block', () => {
  const metrics = extractMetrics(SAMPLE);
  const summary = formatMetricsSummary(metrics, 45000, { ok: true, detail: 'dotnet build: ok' });
  assert.match(summary, /cost: \$0\.3821/);
  assert.match(summary, /tokens: 4625/);
  assert.match(summary, /measured wall-clock: 45000 ms/);
  assert.match(summary, /dotnet build: PASS/);
  assert.doesNotMatch(summary, /```/, 'a passing build must not print a failure detail block');
});

test('formatMetricsSummary renders a FAIL build result with the failure detail inline', () => {
  const metrics = extractMetrics({});
  const summary = formatMetricsSummary(metrics, 1000, { ok: false, detail: 'error CS1002: ; expected' });
  assert.match(summary, /cost: unknown/);
  assert.match(summary, /tokens: unknown/);
  assert.match(summary, /dotnet build: FAIL/);
  assert.match(summary, /error CS1002/);
});
