/**
 * `scaffold status [--json]`: rescans every tracked .scaffold/pending/*.json
 * file. A block's current content no longer matching its recorded
 * placeholder means it's resolved; the command's caller should exit
 * non-zero while any block across any pending file remains unresolved, and
 * 0 once none do. This is the scriptable, host-agnostic checkpoint used by
 * either host adapter, a CI job, or a Claude Code hook.
 *
 * The rescan itself lives in resolveUnresolved.ts, shared with `scaffold
 * next` (next.ts) so the two commands can never disagree about what's open.
 */

import { scanUnresolvedBlocks } from './resolveUnresolved.js';

export interface UnresolvedBlock {
  file: string;
  startLine: number;
  endLine: number;
}

export interface StatusResult {
  resolvedAll: boolean;
  unresolved: UnresolvedBlock[];
}

export function computeStatus(repoRoot: string): StatusResult {
  const unresolved: UnresolvedBlock[] = scanUnresolvedBlocks(repoRoot).map(({ file, startLine, endLine }) => ({ file, startLine, endLine }));
  return { resolvedAll: unresolved.length === 0, unresolved };
}
