/**
 * Pure-function unit tests for src/precheck.mjs.
 *
 * Decision-fn tests do not spawn any subprocess — they exercise the
 * (exitCode, stdout) → decision mapping directly, so each branch is
 * covered with deterministic input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrecheckDecision, renderPendingText } from '../src/precheck.mjs';

test('buildPrecheckDecision: exit 0 returns { ok: true } regardless of stdout', () => {
  // `scaffold status` with no pending records always exits 0 with JSON-shaped
  // stdout, but if a tool ever piped garbage text the contract is: exit
  // code is authoritative for "is anything pending".
  assert.equal(buildPrecheckDecision(0, '{"resolvedAll":true,"unresolved":[]}').ok, true);
  assert.equal(buildPrecheckDecision(0, 'anything').ok, true);
});

test('buildPrecheckDecision: non-zero exit with parseable JSON → unresolved list extracted', () => {
  const stdout = JSON.stringify({
    resolvedAll: false,
    unresolved: [
      { file: 'src/Endpoints/InvoiceEndpoint.cs', startLine: 6, endLine: 8 },
      { file: 'src/Services/InvoiceService.cs', startLine: 12, endLine: 14 },
    ],
  });
  const d = buildPrecheckDecision(1, stdout);
  assert.equal(d.ok, false);
  assert.deepEqual(d.unresolved, [
    { file: 'src/Endpoints/InvoiceEndpoint.cs', startLine: 6, endLine: 8 },
    { file: 'src/Services/InvoiceService.cs', startLine: 12, endLine: 14 },
  ]);
  assert.equal(d.raw, stdout.trim());
});

test('buildPrecheckDecision: non-zero exit with unparseable stdout (scaffold binary missing) → unresolved = []', () => {
  // execFile rejecting with ENOENT-style spawn failure reaches this branch
  // because error.stdout is empty / not parseable.
  const d = buildPrecheckDecision(1, '');
  assert.equal(d.ok, false);
  assert.deepEqual(d.unresolved, []);
  assert.equal(d.raw, '');
});

test('buildPrecheckDecision: non-zero exit with parseable JSON missing the unresolved key → []', () => {
  const d = buildPrecheckDecision(2, '{"unexpected":"shape"}');
  assert.equal(d.ok, false);
  assert.deepEqual(d.unresolved, []);
});

test('buildPrecheckDecision: non-zero exit with garbage text → [] with raw preserved', () => {
  const d = buildPrecheckDecision(1, 'scaffold: command not found\n');
  assert.equal(d.ok, false);
  assert.deepEqual(d.unresolved, []);
  assert.match(d.raw, /command not found/);
});

test('renderPendingText: empty list returns "(none)"', () => {
  assert.equal(renderPendingText([]), '(none)');
});

test('renderPendingText: single-block list', () => {
  assert.equal(
    renderPendingText([{ file: 'Program.cs', startLine: 5, endLine: 7 }]),
    'Program.cs:5-7',
  );
});

test('renderPendingText: multi-block list joins with comma+space', () => {
  const text = renderPendingText([
    { file: 'a.cs', startLine: 1, endLine: 3 },
    { file: 'b.ts', startLine: 7, endLine: 9 },
    { file: 'c.go', startLine: 14, endLine: 16 },
  ]);
  assert.equal(text, 'a.cs:1-3, b.ts:7-9, c.go:14-16');
});
