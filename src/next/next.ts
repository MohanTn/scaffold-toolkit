/**
 * `scaffold next [--json]`: reshapes the same rescan `scaffold status` uses
 * into a compact, agent-facing work digest — file path, line range, and
 * current placeholder body per still-open block. Deliberately carries no
 * enclosing signature and no per-block authored hint: the host agent
 * already has the feature-request context that matters, so this command's
 * only job is pointing it at exactly the blocks left to fill, without it
 * re-reading every generated file to find them. The one exception is
 * `conventions`: an optional, once-per-payload preamble of pack-authored
 * house rules (see next/conventions.ts), attached when every open block
 * traces back to the same pack version.
 */

import { scanUnresolvedBlocks } from '../status/resolveUnresolved.js';
import { resolveConventions } from './conventions.js';

export interface NextBlock {
  file: string;
  startLine: number;
  endLine: number;
  required: boolean;
  placeholder: string;
}

export interface NextResult {
  done: boolean;
  conventions?: string;
  blocks: NextBlock[];
}

export function computeNext(repoRoot: string): NextResult {
  const unresolved = scanUnresolvedBlocks(repoRoot);
  const blocks: NextBlock[] = unresolved.map(({ file, startLine, endLine, content, required }) => ({
    file,
    startLine,
    endLine,
    required,
    placeholder: content,
  }));
  const result: NextResult = { done: blocks.length === 0, blocks };
  const conventions = resolveConventions(repoRoot, unresolved);
  if (conventions !== undefined) result.conventions = conventions;
  return result;
}
