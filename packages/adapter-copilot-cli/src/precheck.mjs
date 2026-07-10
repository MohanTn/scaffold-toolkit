/**
 * Scaffold-status precheck and execFile wrappers.
 *
 * Subcommand flow:
 *   1. `buildPrecheckDecision` is a *pure* function: given the exit code and
 *      stdout of `scaffold status --json`, returns either { ok: true } or
 *      { ok: false, unresolved: [...], raw }. Pure decision → real unit tests,
 *      no subprocess spawning needed for the decision logic.
 *   2. `runStatus` is a small IO shell that wraps execFile('scaffold',
 *      ['status', '--json']). On spawn failure (binary missing), returns
 *      exitCode 1 with empty stdout — `buildPrecheckDecision` treats that
 *      as `ok: false, unresolved: []`, which surfaces to callers as "scaffold
 *      itself is unreachable" rather than "no pending blocks".
 *   3. `runGenerate` mirrors the same pattern for `scaffold generate`.
 *
 * This split mirrors the discipline established in
 * `packages/adapter-claude-code/hooks/post-tool-use.mjs`: the decision is a
 * pure function of (exitCode, stdout), so `test/precheck.test.mjs` can cover
 * every branch without spawning a subprocess.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @typedef {{ file: string, startLine: number, endLine: number }} UnresolvedBlock
 */

/**
 * Pure decision function.
 *
 * @param {number} statusExitCode
 * @param {string} statusStdout
 * @returns {{ ok: true } | { ok: false, unresolved: UnresolvedBlock[], raw: string }}
 */
export function buildPrecheckDecision(statusExitCode, statusStdout) {
  if (statusExitCode === 0) return { ok: true };
  let parsed = null;
  try { parsed = JSON.parse(statusStdout); } catch { /* leave parsed = null */ }
  const unresolved = parsed && Array.isArray(parsed.unresolved) ? parsed.unresolved : [];
  return { ok: false, unresolved, raw: (statusStdout || '').trim() };
}

/**
 * Run `scaffold status --json` in `cwd`. Always resolves with
 * `{ exitCode, stdout }` — never rejects.
 *
 *   - exit 0: every tracked block is resolved.
 *   - exit non-zero: at least one block unresolved (status printed JSON)
 *                OR the binary itself wasn't found (stdout empty).
 *
 * @param {string} cwd
 * @returns {Promise<{ exitCode: number, stdout: string }>}
 */
export async function runStatus(cwd) {
  try {
    const { stdout } = await execFileAsync('scaffold', ['status', '--json'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout };
  } catch (error) {
    // execFile rejects on non-zero exit AND on spawn failure (ENOENT-like).
    // In both cases, abuse exitCode=1 to signal "anything other than fully clean"
    // and surface whatever stdout (status JSON or nothing) we managed to collect.
    return {
      exitCode: 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
    };
  }
}

/**
 * Run `scaffold generate [--manifest <file>] [<passthrough>...]` in `cwd`.
 * Always resolves; never rejects. The caller streams `stdout`/`stderr` to
 * its own process streams.
 *
 * @param {string} cwd
 * @param {string} manifestPath
 * @param {string[]} [passthrough]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function runGenerate(cwd, manifestPath, passthrough = []) {
  const args = ['generate', '--manifest', manifestPath, ...passthrough];
  try {
    const { stdout, stderr } = await execFileAsync('scaffold', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: typeof error?.code === 'number' ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    };
  }
}

/**
 * Render an unresolved-block list as `file:start-end, file:start-end, ...`,
 * or `(none)` for an empty list. Stable text representation for both human
 * stderr output and test assertions.
 *
 * @param {UnresolvedBlock[]} unresolved
 * @returns {string}
 */
export function renderPendingText(unresolved) {
  if (!unresolved || unresolved.length === 0) return '(none)';
  return unresolved.map((b) => `${b.file}:${b.startLine}-${b.endLine}`).join(', ');
}
