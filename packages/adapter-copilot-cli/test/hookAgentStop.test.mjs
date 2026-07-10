import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStopDecision } from '../hooks/agent-stop.mjs';

test('buildStopDecision allows the stop when status resolved (exit 0)', () => {
  assert.deepEqual(buildStopDecision(0, '{"resolvedAll":true,"unresolved":[]}'), { decision: 'allow' });
});

test('buildStopDecision blocks the stop and names the unresolved blocks when status is non-zero', () => {
  const statusOutput = JSON.stringify({
    resolvedAll: false,
    unresolved: [{ file: 'src/Endpoints/InvoiceEndpoint.cs', startLine: 5, endLine: 7 }],
  });
  const decision = buildStopDecision(1, statusOutput);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /src\/Endpoints\/InvoiceEndpoint\.cs:5-7/);
});

test('buildStopDecision degrades gracefully when status stdout is not valid JSON', () => {
  const decision = buildStopDecision(1, 'scaffold: command not found');
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /scaffold: command not found/);
});
