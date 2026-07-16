import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shouldInjectStandingInstruction, buildDecision } from '../hooks/session-start.mjs';

test('shouldInjectStandingInstruction is false for a repo with no .scaffold/config.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-ccli-ss-'));
  assert.equal(shouldInjectStandingInstruction(dir), false);
});

test('shouldInjectStandingInstruction is true once .scaffold/config.json exists', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-ccli-ss-'));
  mkdirSync(path.join(dir, '.scaffold'), { recursive: true });
  writeFileSync(path.join(dir, '.scaffold', 'config.json'), '{"projectType":"dotnet","packs":{}}\n');
  assert.equal(shouldInjectStandingInstruction(dir), true);
});

test('buildDecision returns an empty object when no config is present', () => {
  assert.deepEqual(buildDecision(false), {});
});

test('buildDecision injects a standing instruction via the flat additionalContext field when config is present', () => {
  const decision = buildDecision(true);
  assert.match(decision.additionalContext, /scaffold generate/);
  assert.match(decision.additionalContext, /AI_IMPLEMENTATION/);
  assert.equal(Object.prototype.hasOwnProperty.call(decision, 'hookSpecificOutput'), false, "Copilot sessionStart output is flat, unlike Claude Code's nested hookSpecificOutput shape");
  assert.equal(Object.prototype.hasOwnProperty.call(decision, 'decision'), false, 'this hook only injects context — it must never block anything');
});
