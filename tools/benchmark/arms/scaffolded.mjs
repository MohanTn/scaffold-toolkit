/**
 * Scaffolded arm: spawns a real `claude -p` session against a copy of the
 * shared base repo, with a `scaffold` shell wrapper prepended to PATH —
 * mirrors the pattern packages/adapter-claude-code/test/_harness.mjs and
 * packages/adapter-copilot-cli/test/_harness.mjs already use to put
 * scaffold-core on PATH for a spawned child process — plus the
 * SKILL.md-following prompt.
 *
 * Spends real Anthropic API money every time it runs. Only ever invoked by
 * run-benchmark.mjs (never by an automated test).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildScaffoldedPrompt } from '../prompts.mjs';
import { CORE_CLI } from '../fixtureRepo.mjs';

/** Same shell-wrapper approach as the adapter packages' own test harnesses — unambiguous across runners, no symlink assumptions. */
function scaffoldBinDir() {
  const binDir = mkdtempSync(path.join(tmpdir(), 'scaffold-benchmark-bindir-'));
  const wrapper = path.join(binDir, 'scaffold');
  writeFileSync(wrapper, `#!/bin/sh\nexec node '${CORE_CLI.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  return binDir;
}

/**
 * @param {{ repoDir: string, maxBudgetUsd: number, promptOverride?: string }} options
 * @returns {{ stdout: string, stderr: string, status: number, wallClockMs: number }}
 */
export function runScaffoldedArm({ repoDir, maxBudgetUsd, promptOverride }) {
  const prompt = promptOverride ?? buildScaffoldedPrompt();
  const binDir = scaffoldBinDir();

  try {
    const start = Date.now();
    const result = spawnSync(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--max-budget-usd', String(maxBudgetUsd)],
      { cwd: repoDir, encoding: 'utf8', env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const wallClockMs = Date.now() - start;

    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1, wallClockMs };
  } finally {
    // Unlike the arm repo checkouts (removed by run-benchmark.mjs once the
    // arm's own result has been graded), this tmpdir holds nothing the
    // caller needs afterward — it only exists to put a `scaffold` shim on
    // PATH for the spawnSync call above, so it's safe (and necessary) to
    // clean up unconditionally, on both the success and throw paths.
    rmSync(binDir, { recursive: true, force: true });
  }
}
