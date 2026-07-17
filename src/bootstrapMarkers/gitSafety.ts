/**
 * Hand-rolled execFile('git', [...]) wrapper mirroring templates/gitClone.ts's
 * pattern. Unlike gitClone.ts (which is driven from `scaffold templates
 * sync`'s async flow), runBootstrapMarkers is a synchronous orchestrator end
 * to end, so this uses execFileSync rather than promisified execFile.
 */

import { execFileSync } from 'node:child_process';

interface ExecFailure {
  code?: string;
  stderr?: Buffer | string;
}

/**
 * True only for git's own clean "you're genuinely not inside a repository"
 * signal — never for the git binary being missing (ENOENT) or any other
 * unexpected failure. Conflating those would silently disable the entire
 * tracked-and-clean safety net (docs/prd.md is explicit that a dirty or
 * untracked file must never be silently skipped), so callers must be able to
 * tell "no repo here, skip the check" apart from "the check itself broke."
 */
export function isNotAGitRepositoryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & ExecFailure;
  if (failure.code === 'ENOENT') return false; // the git binary itself is missing — a real failure, not "no repo here"
  const stderr = failure.stderr ? failure.stderr.toString() : '';
  return /not a git repository/i.test(stderr);
}

/**
 * True if `repoRoot` is inside a git working tree; false, without throwing,
 * specifically when `repoRoot` has no git repo at all. Any other failure
 * (e.g. the git binary is missing, or an unexpected error) throws instead of
 * silently returning false, so the command fails loud rather than quietly
 * disabling its own git-safety net.
 */
export function isInsideGitWorkTree(repoRoot: string): boolean {
  try {
    const stdout = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    return stdout.toString().trim() === 'true';
  } catch (error) {
    if (isNotAGitRepositoryError(error)) return false;
    throw error;
  }
}

/** True if `relativeFile` is tracked by git and has no working-tree changes (via `git status --porcelain`). Untracked or dirty files, and any git error, return false. */
export function isFileCleanAndTracked(repoRoot: string, relativeFile: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relativeFile], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return false; // not tracked
  }
  try {
    const stdout = execFileSync('git', ['status', '--porcelain', '--', relativeFile], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
    return stdout.toString().trim().length === 0;
  } catch {
    return false;
  }
}
