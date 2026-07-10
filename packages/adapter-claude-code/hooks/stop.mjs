#!/usr/bin/env node
/**
 * Stop hook: fires when Claude is about to end its turn. Runs `scaffold
 * status --json` in the session's cwd; if any AI_IMPLEMENTATION block is
 * still pending, it returns a blocking decision so Claude cannot end the
 * turn — chosen deliberately over a soft warning, since a soft nudge just
 * reintroduces the non-determinism this feature exists to remove. If status
 * exits 0 (nothing pending), the turn is allowed to end normally.
 *
 * Contract (verified against https://code.claude.com/docs/en/hooks, fetched
 * 2026-07 — see this repo's BUILT handoff for the exact fields verified and
 * what could not be independently confirmed): the Stop hook's stdin JSON
 * does not include tool details (it isn't a tool-use event), just session
 * metadata plus `last_assistant_message`; this script only needs `cwd` from
 * that payload. Output is JSON on stdout with `decision: "block"` plus
 * `reason` to prevent the stop and feed Claude the reason to act on; an
 * empty object (or a JSON with no `decision`) allows the stop.
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
 * print. Exit 0 means every previously-pending block now has real content,
 * so the turn is allowed to end (empty object, no `decision`).
 */
export function buildStopDecision(statusExitCode, statusStdout) {
  if (statusExitCode === 0) return {};
  const summary = summarizeUnresolved(statusStdout);
  const detail = summary ? `: ${summary}` : ' (see scaffold status --json for detail).';
  return {
    decision: 'block',
    reason:
      `scaffold status still reports unfilled AI_IMPLEMENTATION block(s)${detail} ` +
      'Fill each one with your Edit tool (use the current-content field from the generate report so an already-completed block is never re-filled), then try to stop again.',
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
