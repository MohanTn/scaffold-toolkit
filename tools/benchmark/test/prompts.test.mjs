/**
 * Pure tests for prompts.mjs — no live API calls, just string assertions on
 * the generated prompt text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFreehandPrompt, buildScaffoldedPrompt, ORDER_TASK_DESCRIPTION } from '../prompts.mjs';

test('buildFreehandPrompt includes the shared task description', () => {
  const prompt = buildFreehandPrompt();
  assert.match(prompt, /Order/);
  assert.match(prompt, /CRUD/);
});

test('buildFreehandPrompt explicitly forbids the scaffold CLI', () => {
  const prompt = buildFreehandPrompt();
  assert.match(prompt, /do not use, invoke, or reference the "scaffold" cli/i);
  assert.doesNotMatch(prompt, /scaffold generate/i, 'the freehand prompt must never instruct running scaffold generate');
});

test('buildScaffoldedPrompt includes the shared task description', () => {
  const prompt = buildScaffoldedPrompt();
  assert.match(prompt, /Order/);
  assert.match(prompt, /CRUD/);
});

test('buildScaffoldedPrompt instructs following the SKILL.md workflow: manifest, generate, then fill AI_IMPLEMENTATION blocks', () => {
  const prompt = buildScaffoldedPrompt();
  assert.match(prompt, /intent manifest/i);
  assert.match(prompt, /scaffold generate/i);
  assert.match(prompt, /AI_IMPLEMENTATION/);
});

test('both prompts accept a task description override, for future benchmark entities beyond Order', () => {
  const custom = 'Add a new "Invoice" entity with fields id and amount.';
  assert.match(buildFreehandPrompt(custom), /Invoice/);
  assert.match(buildScaffoldedPrompt(custom), /Invoice/);
  assert.doesNotMatch(buildFreehandPrompt(custom), /"Order"/);
});

test('the default task description is exported and used by both prompt builders by default', () => {
  assert.match(buildFreehandPrompt(), new RegExp(ORDER_TASK_DESCRIPTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40)));
});
