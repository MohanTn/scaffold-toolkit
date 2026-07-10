import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCheckStatus, buildDecision } from '../hooks/post-tool-use.mjs';

test('shouldCheckStatus is false for a non-bash tool call', () => {
  assert.equal(shouldCheckStatus({ toolName: 'edit', toolArgs: { command: 'scaffold generate --manifest x' } }), false);
});

test('shouldCheckStatus is false for a bash call that does not mention scaffold generate', () => {
  assert.equal(shouldCheckStatus({ toolName: 'bash', toolArgs: { command: 'npm test' } }), false);
});

test('shouldCheckStatus is true for a bash call whose command mentions scaffold generate directly', () => {
  assert.equal(shouldCheckStatus({ toolName: 'bash', toolArgs: { command: 'scaffold generate --manifest x.toon' } }), true);
});

test('shouldCheckStatus is true for the npx @mohantn/scaffold-core form', () => {
  assert.equal(shouldCheckStatus({ toolName: 'bash', toolArgs: { command: 'npx -y @mohantn/scaffold-core generate --manifest /tmp/x.toon' } }), true);
});

test('shouldCheckStatus parses toolArgs delivered as a JSON-encoded string, per the hooks tutorial example payload', () => {
  assert.equal(
    shouldCheckStatus({ toolName: 'bash', toolArgs: '{"command":"npx -y @mohantn/scaffold-core generate --manifest x.toon"}' }),
    true,
  );
});

test('shouldCheckStatus does not false-positive on an unrelated hyphenated command', () => {
  assert.equal(shouldCheckStatus({ toolName: 'bash', toolArgs: { command: 'echo scaffold-core-generate-notreal' } }), false);
});

test('shouldCheckStatus tolerates missing/malformed input', () => {
  assert.equal(shouldCheckStatus(undefined), false);
  assert.equal(shouldCheckStatus({}), false);
  assert.equal(shouldCheckStatus({ toolName: 'bash' }), false);
  assert.equal(shouldCheckStatus({ toolName: 'bash', toolArgs: 'not valid json' }), false);
});

test('buildDecision returns an empty object (no nudge) when status resolved (exit 0)', () => {
  assert.deepEqual(buildDecision(0, '{"resolvedAll":true,"unresolved":[]}'), {});
});

test('buildDecision surfaces the unresolved block list as a flat additionalContext when status is non-zero', () => {
  const statusOutput = JSON.stringify({
    resolvedAll: false,
    unresolved: [{ file: 'src/Endpoints/InvoiceEndpoint.cs', startLine: 5, endLine: 7 }],
  });
  const decision = buildDecision(1, statusOutput);
  assert.match(decision.additionalContext, /src\/Endpoints\/InvoiceEndpoint\.cs:5-7/);
  assert.equal(Object.prototype.hasOwnProperty.call(decision, 'hookSpecificOutput'), false, 'Copilot postToolUse output is flat, unlike Claude Code\'s nested hookSpecificOutput shape');
});

test('buildDecision degrades gracefully when status stdout is not valid JSON', () => {
  const decision = buildDecision(1, 'scaffold: command not found');
  assert.match(decision.additionalContext, /scaffold: command not found/);
});
