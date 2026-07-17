/**
 * Hand-rolled execFile('git', [...]) wrapper for template-pack cloning,
 * mirroring pipeline_worker/src/git/*.ts's own pattern — no simple-git
 * dependency for something this thin covers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Resolves the commit SHA a pack repo's HEAD currently points at, without cloning it. Works against local paths too (used by fixtures). */
export async function resolveHeadSha(url: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['ls-remote', url, 'HEAD']);
  const line = stdout.split('\n').find((l) => l.trim().length > 0);
  if (!line) {
    throw new Error(`could not resolve HEAD for template pack remote "${url}" — is it a valid git repository?`);
  }
  return line.split('\t')[0].trim();
}

/** Clones `url`'s default branch into `destDir` (which must not already exist). */
export async function cloneToDir(url: string, destDir: string): Promise<void> {
  await execFileAsync('git', ['clone', '--quiet', url, destDir]);
}
