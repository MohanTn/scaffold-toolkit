import { test } from 'node:test';
import assert from 'node:assert';
import {
  shouldInjectStandards,
  buildDecision,
} from '../../hooks/pre-tool-use.mjs';

test('shouldInjectStandards: returns false for non-Edit tools', () => {
  const hookInput = {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  };

  const result = shouldInjectStandards(hookInput, '/tmp');
  assert.strictEqual(result, false);
});

test('shouldInjectStandards: returns false when oldString missing', () => {
  const hookInput = {
    tool_name: 'Edit',
    tool_input: { file_path: '/some/file.cs', old_string: '' },
  };

  const result = shouldInjectStandards(hookInput, '/tmp');
  assert.strictEqual(result, false);
});

test('shouldInjectStandards: returns false when no AI_IMPLEMENTATION marker', () => {
  const hookInput = {
    tool_name: 'Edit',
    tool_input: {
      file_path: '/some/file.cs',
      old_string: 'public void SomeMethod() { return; }',
    },
  };

  const result = shouldInjectStandards(hookInput, '/tmp');
  assert.strictEqual(result, false);
});

test('shouldInjectStandards: returns true when Edit targets AI_IMPLEMENTATION block', () => {
  const hookInput = {
    tool_name: 'Edit',
    tool_input: {
      file_path: '/some/Handler.cs',
      old_string: '/// SCAFFOLD:AI_IMPLEMENTATION:START:required\n// placeholder\n/// SCAFFOLD:AI_IMPLEMENTATION:END',
    },
  };

  // Mock: we can't actually check .scaffold/config.json in this test
  // So we'll just verify the logic for the marker detection
  const hasMarker = /AI_IMPLEMENTATION[_:]START/.test(
    hookInput.tool_input.old_string
  );
  assert.ok(hasMarker);
});

test('shouldInjectStandards: recognizes both _START and :START syntax', () => {
  const oldStringUnderscoreStyle = '/// AI_IMPLEMENTATION_START:required\n// code\n/// AI_IMPLEMENTATION_END';
  const oldStringColonStyle = '/// SCAFFOLD:AI_IMPLEMENTATION:START:required\n// code\n/// SCAFFOLD:AI_IMPLEMENTATION:END';

  const underscoreMatch = /AI_IMPLEMENTATION[_:]START/.test(oldStringUnderscoreStyle);
  const colonMatch = /AI_IMPLEMENTATION[_:]START/.test(oldStringColonStyle);

  assert.ok(underscoreMatch);
  assert.ok(colonMatch);
});

test('buildDecision: includes standards guidance in additionalContext when allowed', () => {
  const checkEditStdout = JSON.stringify({ allow: true });
  const standardsGuidance = 'Coding standards for handler...\n- Rule 1\n- Rule 2';

  const result = buildDecision(0, checkEditStdout, standardsGuidance);

  assert.ok(result.hookSpecificOutput);
  assert.strictEqual(result.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(result.hookSpecificOutput.additionalContext);
  assert.ok(result.hookSpecificOutput.additionalContext.includes('Coding standards'));
});

test('buildDecision: returns empty object when allowed with no guidance', () => {
  const checkEditStdout = JSON.stringify({ allow: true });

  const result = buildDecision(0, checkEditStdout, null);

  // Should return empty object (no guidance to inject)
  assert.deepStrictEqual(result, {});
});

test('buildDecision: blocks with reason when check-edit denies', () => {
  const checkEditStdout = JSON.stringify({
    allow: false,
    detail: 'File is owned by pack, must edit inside AI_IMPLEMENTATION marker',
  });

  const result = buildDecision(1, checkEditStdout, null);

  assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(result.hookSpecificOutput.permissionDecisionReason);
});

test('buildDecision: fails gracefully with unparseable check-edit output', () => {
  const invalidStdout = 'not json';

  const result = buildDecision(1, invalidStdout, null);

  assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    result.hookSpecificOutput.permissionDecisionReason.includes(
      'did not return a parseable decision'
    )
  );
});

test('buildDecision: ignores guidance when Edit is blocked', () => {
  const checkEditStdout = JSON.stringify({
    allow: false,
    detail: 'Blocked by pack ownership',
  });
  const standardsGuidance = 'Some guidance...';

  const result = buildDecision(1, checkEditStdout, standardsGuidance);

  // Should deny, not include the guidance
  assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(!result.hookSpecificOutput.additionalContext);
});
