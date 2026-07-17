import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shouldInjectStandingInstruction, buildDecision } from '../../hooks/user-prompt-submit.mjs';

test('shouldInjectStandingInstruction is false for a repo with no .scaffold/config.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-ups-'));
  assert.equal(shouldInjectStandingInstruction(dir), false);
});

test('shouldInjectStandingInstruction is true once .scaffold/config.json exists, unconditional on any prompt content', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-ups-'));
  mkdirSync(path.join(dir, '.scaffold'), { recursive: true });
  writeFileSync(path.join(dir, '.scaffold', 'config.json'), '{"projectType":"dotnet","packs":{}}\n');
  assert.equal(shouldInjectStandingInstruction(dir), true);
});

test('buildDecision returns an empty object when no config is present', () => {
  assert.deepEqual(buildDecision(false), {});
});

test('buildDecision injects a standing instruction via hookSpecificOutput.additionalContext when config is present (gate mode, the default)', () => {
  const decision = buildDecision(true);
  assert.equal(decision.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(decision.hookSpecificOutput.additionalContext, /scaffold generate/);
  assert.match(decision.hookSpecificOutput.additionalContext, /AI_IMPLEMENTATION/);
  assert.match(decision.hookSpecificOutput.additionalContext, /will block/);
  assert.equal(Object.prototype.hasOwnProperty.call(decision, 'decision'), false, 'this hook only injects context — it must never block the prompt itself');
});

test('buildDecision describes nudge mode instead of blocking language when mode is "nudge"', () => {
  const decision = buildDecision(true, 'nudge');
  assert.match(decision.hookSpecificOutput.additionalContext, /nudge/);
  assert.doesNotMatch(decision.hookSpecificOutput.additionalContext, /will block/);
});
