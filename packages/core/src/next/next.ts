/**
 * `scaffold next [--json]`: reshapes the same rescan `scaffold status` uses
 * into a compact, agent-facing work digest — file path, line range, and
 * current placeholder body per still-open block. Deliberately carries no
 * enclosing signature and no authored hint: the host agent already has the
 * feature-request context that matters, so this command's only job is
 * pointing it at exactly the blocks left to fill, without it re-reading
 * every generated file to find them.
 */

import { scanUnresolvedBlocks } from '../status/resolveUnresolved.js';

export interface NextBlock {
  file: string;
  startLine: number;
  endLine: number;
  required: boolean;
  placeholder: string;
}

export interface NextResult {
  done: boolean;
  blocks: NextBlock[];
}

export function computeNext(repoRoot: string): NextResult {
  const blocks: NextBlock[] = scanUnresolvedBlocks(repoRoot).map(({ file, startLine, endLine, content, required }) => ({
    file,
    startLine,
    endLine,
    required,
    placeholder: content,
  }));
  return { done: blocks.length === 0, blocks };
}
