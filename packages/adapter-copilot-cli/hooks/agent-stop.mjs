#!/usr/bin/env node
/**
 * agentStop hook for GitHub Copilot CLI (schema per
 * https://docs.github.com/en/copilot/reference/hooks-reference, confirmed
 * 2026-07): fires when the agent is about to end its turn/session. Runs
 * `scaffold status --json` in the session's cwd; if any AI_IMPLEMENTATION
 * block is still pending, returns a blocking decision so the agent cannot
 * end the turn — chosen deliberately over a soft warning, mirroring the
 * Claude Code adapter's Stop hook (stop.mjs) and its own reasoning: a soft
 * nudge just reintroduces the non-determinism this feature exists to
 * remove. If status exits 0 (nothing pending), the turn is allowed to end.
 *
 * This is what closes the PRD's previously-stated platform gap: GitHub
 * Copilot CLI has supported hooks (including agentStop) since its GA in
 * February 2026, so it can now get the same "cannot stop with unfilled
 * blocks" guarantee Claude Code's Stop hook already gives.
 *
 * Output shape (per the hooks reference): `{ decision: "block" | "allow",
 * reason? }` — unlike Claude Code's Stop hook, where omitting `decision`
 * implicitly allows the stop, Copilot's schema documents `decision` as
 * required, so this script always sets it explicitly rather than relying
 * on an undocumented default.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
 * Pure decision function, unit-tested directly: given `scaffold status
 * --json`'s real exit code and stdout, returns the JSON this hook should
 * print.
 */
export function buildStopDecision(statusExitCode, statusStdout) {
  if (statusExitCode === 0) return { decision: 'allow' };
  const summary = summarizeUnresolved(statusStdout);
  const detail = summary ? `: ${summary}` : ' (see scaffold status --json for detail).';
  return {
    decision: 'block',
    reason:
      `scaffold status still reports unfilled AI_IMPLEMENTATION block(s)${detail} ` +
      'Fill each one with your file-editing tool (use the current-content field from the generate report so an already-completed block is never re-filled), then try to stop again.',
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
  const cwd = hookInput.cwd || process.cwd();

  const { exitCode, stdout } = runStatus(cwd);
  process.stdout.write(JSON.stringify(buildStopDecision(exitCode, stdout)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
