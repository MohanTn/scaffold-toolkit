/**
 * Freehand arm: spawns a real `claude -p` session against a copy of the
 * shared base repo, with the scaffold CLI intentionally NOT on PATH — the
 * prompt's own "don't use scaffold" instruction (prompts.mjs) isn't trusted
 * as the only guardrail against Claude discovering and invoking it anyway,
 * which would collapse this arm into a second copy of the scaffolded one.
 *
 * Spends real Anthropic API money every time it runs. Only ever invoked by
 * run-benchmark.mjs (never by an automated test).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildFreehandPrompt } from '../prompts.mjs';

/** Every PATH entry that would resolve a `scaffold` binary is dropped — a real guardrail, not just a polite prompt request. */
function pathWithoutScaffold() {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter((segment) => segment.length > 0 && !existsSync(path.join(segment, 'scaffold')))
    .join(path.delimiter);
}

/**
 * @param {{ repoDir: string, maxBudgetUsd: number, promptOverride?: string }} options
 * @returns {{ stdout: string, stderr: string, status: number, wallClockMs: number }}
 */
export function runFreehandArm({ repoDir, maxBudgetUsd, promptOverride }) {
  const prompt = promptOverride ?? buildFreehandPrompt();

  const start = Date.now();
  const result = spawnSync(
    'claude',
    ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--max-budget-usd', String(maxBudgetUsd)],
    { cwd: repoDir, encoding: 'utf8', env: { ...process.env, PATH: pathWithoutScaffold() } },
  );
  const wallClockMs = Date.now() - start;

  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1, wallClockMs };
}
