#!/usr/bin/env node
/**
 * PostToolUse hook: fires after every tool call Claude makes. Only acts when
 * the tool was Bash and its command contains "scaffold generate" — every
 * other tool call is a silent no-op (exit 0, empty JSON).
 *
 * When it does act, it runs `scaffold status --json` in the same directory
 * and, if anything is still pending, feeds that back into Claude's context
 * via `hookSpecificOutput.additionalContext`. This is deliberately a nudge,
 * not a block: PostToolUse fires after the tool already ran (per Claude
 * Code's hooks reference, https://code.claude.com/docs/en/hooks, fetched
 * 2026-07 — see this repo's BUILT handoff for the exact fields verified),
 * so there is nothing left to prevent; `decision: "block"` on this event
 * would hide the tool's real output from Claude rather than just nudging it,
 * which is not what we want here. The hard, un-skippable enforcement is the
 * Stop hook (stop.mjs) — this script is the earlier, softer signal.
 *
 * Exit code contract (verified against the docs above): exit 0 and Claude
 * Code parses stdout as the hook's JSON output.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMainModule } from './isMainModule.mjs';

// Matches a real `scaffold generate` invocation whether run as the bare
// `scaffold` binary or via `npx @mohantn/scaffold-core` (which puts the
// package name's "-core" suffix directly before "generate", e.g.
// "npx -y @mohantn/scaffold-core generate --manifest x.toon"). A literal
// `command.includes('scaffold generate')` check misses that npx form
// entirely, which is the exact invocation SKILL.md instructs Claude to run.
const SCAFFOLD_GENERATE_PATTERN = /\bscaffold(?:-core)?\s+generate\b/;

/** True only for a Bash tool call whose command string invokes `scaffold generate` (directly or via `npx @mohantn/scaffold-core`). */
export function shouldCheckStatus(hookInput) {
  if (!hookInput || hookInput.tool_name !== 'Bash') return false;
  const command = hookInput.tool_input && hookInput.tool_input.command;
  return typeof command === 'string' && SCAFFOLD_GENERATE_PATTERN.test(command);
}

function summarizeUnresolved(statusStdout) {
  try {
    const parsed = JSON.parse(statusStdout);
    const unresolved = Array.isArray(parsed.unresolved) ? parsed.unresolved : [];
    if (unresolved.length === 0) return null;
    return unresolved.map((b) => `${b.file}:${b.startLine}-${b.endLine}`).join(', ');
  } catch {
    return statusStdout.trim() || null;
  }
}

/**
 * Pure decision function, kept separate from the child_process call so it
 * has real unit test coverage: given the exit code and stdout `scaffold
 * status --json` actually produced, returns the JSON object this hook
 * should print. A resolved status (exit 0) is a pure no-op — the empty
 * object provides no additionalContext, and Claude Code allows the turn to
 * proceed as normal.
 */
export function buildDecision(statusExitCode, statusStdout) {
  if (statusExitCode === 0) return {};
  const summary = summarizeUnresolved(statusStdout);
  const detail = summary ? `: ${summary}` : ' (see scaffold status --json for detail).';
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `scaffold status reports unfilled AI_IMPLEMENTATION block(s) after this generate run${detail} ` +
        'Fill each one with your Edit tool, using the block\'s current-content from the generate report so an already-completed block is never re-filled.',
    },
  };
}

function runStatus(cwd) {
  try {
    const stdout = execFileSync('scaffold', ['status', '--json'], { cwd, encoding: 'utf8' });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? '' };
  }
}

function main() {
  const raw = readFileSync(0, 'utf8');
  const hookInput = raw.trim() ? JSON.parse(raw) : {};

  if (!shouldCheckStatus(hookInput)) {
    process.stdout.write('{}');
    return;
  }

  const cwd = hookInput.cwd || process.cwd();
  const { exitCode, stdout } = runStatus(cwd);
  process.stdout.write(JSON.stringify(buildDecision(exitCode, stdout)));
}

// Only run as a script (not when imported by tests for its pure functions).
if (isMainModule(import.meta.url)) {
  main();
}
