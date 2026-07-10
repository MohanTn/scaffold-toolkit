#!/usr/bin/env node
/**
 * postToolUse hook for GitHub Copilot CLI (schema per
 * https://docs.github.com/en/copilot/reference/hooks-reference, confirmed
 * 2026-07): fires after every tool call in a Copilot agent session. Only
 * acts when the tool was `bash` and its command invokes `scaffold generate`
 * (directly, or via `npx @mohantn/scaffold-core generate` as `SKILL.md`'s
 * Claude Code counterpart documents and this adapter's own README's
 * manual-verification recipe uses) — every other tool call is a silent
 * no-op (exit 0, empty JSON).
 *
 * When it does act, it runs `scaffold status --json` in the session's cwd
 * and, if anything is still pending, feeds that back via the flat
 * `additionalContext` field Copilot's postToolUse output uses (NOT Claude
 * Code's nested `hookSpecificOutput.additionalContext` — the two hook
 * protocols share the same idea but not the same JSON shape). This is a
 * nudge, not a block: postToolUse fires after the tool already ran, so
 * there's nothing left to prevent. The hard, un-skippable enforcement is
 * the `agentStop` hook (agent-stop.mjs) — this script is the earlier,
 * softer signal, mirroring the Claude Code adapter's own two-layer design.
 *
 * Exit code contract: exit 0 with stdout parsed as this hook's output JSON.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Matches a real `scaffold generate` invocation whether run as the bare
// `scaffold` binary or via `npx @mohantn/scaffold-core` (which puts the
// package name's "-core" suffix directly before "generate").
const SCAFFOLD_GENERATE_PATTERN = /\bscaffold(?:-core)?\s+generate\b/;

/**
 * Copilot's `toolArgs` field is typed `unknown` and has been observed both
 * as a plain object and as a JSON-encoded string (per the hooks tutorial's
 * own example payload) — handle both rather than assuming one shape.
 */
function extractCommand(toolArgs) {
  if (typeof toolArgs === 'string') {
    try {
      return JSON.parse(toolArgs).command;
    } catch {
      return undefined;
    }
  }
  if (toolArgs && typeof toolArgs === 'object') return toolArgs.command;
  return undefined;
}

/** True only for a `bash` tool call whose command string invokes `scaffold generate` (directly or via `npx @mohantn/scaffold-core`). */
export function shouldCheckStatus(hookInput) {
  if (!hookInput || hookInput.toolName !== 'bash') return false;
  const command = extractCommand(hookInput.toolArgs);
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
 * should print. A resolved status (exit 0) is a pure no-op.
 */
export function buildDecision(statusExitCode, statusStdout) {
  if (statusExitCode === 0) return {};
  const summary = summarizeUnresolved(statusStdout);
  const detail = summary ? `: ${summary}` : ' (see scaffold status --json for detail).';
  return {
    additionalContext:
      `scaffold status reports unfilled AI_IMPLEMENTATION block(s) after this generate run${detail} ` +
      "Fill each one with your file-editing tool, using the block's current-content from the generate report so an already-completed block is never re-filled.",
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
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
