/**
 * Tests for the coding-standards injection half of hooks/post-tool-use.mjs.
 * The Claude Code adapter performs this injection in its PreToolUse hook;
 * on Copilot it lives in postToolUse because Copilot's preToolUse output
 * cannot carry additionalContext (see the hook's header comment).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  shouldInjectStandards,
  extractStandardsTarget,
} from '../hooks/post-tool-use.mjs';

function scaffoldManagedDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-ccli-std-'));
  mkdirSync(path.join(dir, '.scaffold'), { recursive: true });
  writeFileSync(path.join(dir, '.scaffold', 'config.json'), '{"projectType":"dotnet","packs":{}}\n');
  return dir;
}

test('shouldInjectStandards: returns false for non-edit tools', () => {
  const hookInput = { toolName: 'bash', toolArgs: { command: 'ls' } };
  assert.strictEqual(shouldInjectStandards(hookInput, scaffoldManagedDir()), false);
});

test('shouldInjectStandards: returns false when oldString missing or empty', () => {
  const hookInput = { toolName: 'edit', toolArgs: { path: '/some/file.cs', oldString: '' } };
  assert.strictEqual(shouldInjectStandards(hookInput, scaffoldManagedDir()), false);
});

test('shouldInjectStandards: returns false when no AI_IMPLEMENTATION marker', () => {
  const hookInput = {
    toolName: 'edit',
    toolArgs: { path: '/some/file.cs', oldString: 'public void SomeMethod() { return; }' },
  };
  assert.strictEqual(shouldInjectStandards(hookInput, scaffoldManagedDir()), false);
});

test('shouldInjectStandards: returns false when repo is not scaffold-managed', () => {
  const bareDir = mkdtempSync(path.join(tmpdir(), 'scaffold-ccli-bare-'));
  const hookInput = {
    toolName: 'edit',
    toolArgs: { path: '/some/Handler.cs', oldString: '// AI_IMPLEMENTATION_START\n// x\n// AI_IMPLEMENTATION_END' },
  };
  assert.strictEqual(shouldInjectStandards(hookInput, bareDir), false);
});

test('shouldInjectStandards: returns true when an edit tool targets an AI_IMPLEMENTATION block in a scaffold-managed repo', () => {
  const hookInput = {
    toolName: 'edit',
    toolArgs: {
      path: '/some/Handler.cs',
      oldString: '/// SCAFFOLD:AI_IMPLEMENTATION:START:required\n// placeholder\n/// SCAFFOLD:AI_IMPLEMENTATION:END',
    },
  };
  assert.strictEqual(shouldInjectStandards(hookInput, scaffoldManagedDir()), true);
});

test('shouldInjectStandards: recognizes both _START and :START syntax across all edit toolNames', () => {
  const dir = scaffoldManagedDir();
  for (const toolName of ['edit', 'str_replace_editor', 'apply_patch']) {
    const underscore = {
      toolName,
      toolArgs: { path: '/x/Handler.cs', oldString: '/// AI_IMPLEMENTATION_START:required\n// code\n/// AI_IMPLEMENTATION_END' },
    };
    const colon = {
      toolName,
      toolArgs: { path: '/x/Handler.cs', oldString: '/// SCAFFOLD:AI_IMPLEMENTATION:START:required\n// code\n/// SCAFFOLD:AI_IMPLEMENTATION:END' },
    };
    assert.strictEqual(shouldInjectStandards(underscore, dir), true, `${toolName} + _START syntax`);
    assert.strictEqual(shouldInjectStandards(colon, dir), true, `${toolName} + :START syntax`);
  }
});

test('extractStandardsTarget: pulls file and oldString from the primary guessed field names', () => {
  const target = extractStandardsTarget({
    toolName: 'edit',
    toolArgs: { path: '/x/Handler.cs', oldString: 'foo' },
  });
  assert.deepStrictEqual(target, { file: '/x/Handler.cs', oldString: 'foo' });
});

test('extractStandardsTarget: tolerates snake_case fallbacks and JSON-encoded toolArgs', () => {
  const target = extractStandardsTarget({
    toolName: 'str_replace_editor',
    toolArgs: JSON.stringify({ file_path: '/x/Handler.cs', old_str: 'foo' }),
  });
  assert.deepStrictEqual(target, { file: '/x/Handler.cs', oldString: 'foo' });
});

test('extractStandardsTarget: returns undefined when the file path is missing', () => {
  assert.strictEqual(extractStandardsTarget({ toolName: 'edit', toolArgs: { oldString: 'x' } }), undefined);
  assert.strictEqual(extractStandardsTarget({ toolName: 'edit', toolArgs: 'not json' }), undefined);
});
