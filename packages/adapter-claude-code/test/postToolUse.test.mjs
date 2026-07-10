import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCheckStatus, buildDecision } from '../hooks/post-tool-use.mjs';

test('shouldCheckStatus is false for a non-Bash tool call', () => {
  assert.equal(shouldCheckStatus({ tool_name: 'Edit', tool_input: { command: 'scaffold generate --manifest x' } }), false);
});

test('shouldCheckStatus is false for a Bash call that does not mention scaffold generate', () => {
  assert.equal(shouldCheckStatus({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), false);
});

test('shouldCheckStatus is true for a Bash call whose command mentions scaffold generate', () => {
  assert.equal(shouldCheckStatus({ tool_name: 'Bash', tool_input: { command: 'npx @mohantn/scaffold-core generate --manifest x.toon' } }), true);
});

test('shouldCheckStatus is true for the npx -y form documented in SKILL.md', () => {
  assert.equal(shouldCheckStatus({ tool_name: 'Bash', tool_input: { command: 'npx -y @mohantn/scaffold-core generate --manifest /tmp/x.toon' } }), true);
});

test('shouldCheckStatus is true for the bare scaffold binary invocation', () => {
  assert.equal(shouldCheckStatus({ tool_name: 'Bash', tool_input: { command: 'scaffold generate --manifest x.toon --force' } }), true);
});

test('shouldCheckStatus does not false-positive on an unrelated hyphenated command', () => {
  assert.equal(shouldCheckStatus({ tool_name: 'Bash', tool_input: { command: 'echo scaffold-core-generate-notreal' } }), false);
});

test('shouldCheckStatus tolerates missing/malformed input', () => {
  assert.equal(shouldCheckStatus(undefined), false);
  assert.equal(shouldCheckStatus({}), false);
  assert.equal(shouldCheckStatus({ tool_name: 'Bash' }), false);
});

test('buildDecision returns an empty object (no nudge) when status resolved (exit 0)', () => {
  assert.deepEqual(buildDecision(0, '{"resolvedAll":true,"unresolved":[]}'), {});
});

test('buildDecision surfaces the unresolved block list as additionalContext when status is non-zero', () => {
  const statusOutput = JSON.stringify({
    resolvedAll: false,
    unresolved: [{ file: 'src/Endpoints/InvoiceEndpoint.cs', startLine: 5, endLine: 7 }],
  });
  const decision = buildDecision(1, statusOutput);
  assert.equal(decision.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(decision.hookSpecificOutput.additionalContext, /src\/Endpoints\/InvoiceEndpoint\.cs:5-7/);
  assert.equal(Object.prototype.hasOwnProperty.call(decision, 'decision'), false, 'PostToolUse must nudge via additionalContext, not decision:block, or it would hide the real tool result from Claude');
});

test('buildDecision degrades gracefully when status stdout is not valid JSON', () => {
  const decision = buildDecision(1, 'scaffold: command not found');
  assert.match(decision.hookSpecificOutput.additionalContext, /scaffold: command not found/);
});
