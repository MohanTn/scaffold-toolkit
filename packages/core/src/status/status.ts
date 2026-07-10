/**
 * `scaffold status [--json]`: rescans every tracked .scaffold/pending/*.json
 * file. A block's current content no longer matching its recorded
 * placeholder means it's resolved; the command's caller should exit
 * non-zero while any block across any pending file remains unresolved, and
 * 0 once none do. This is the scriptable, host-agnostic checkpoint used by
 * either host adapter, a CI job, or a Claude Code hook.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { listPendingRecords, removePendingRecord } from '../generate/pendingTracker.js';
import { scanAiImplementationBlocks } from '../generate/markerScan.js';

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
  const unresolved: UnresolvedBlock[] = [];

  for (const record of listPendingRecords(repoRoot)) {
    let anyUnresolvedInRecord = false;

    for (const block of record.blocks) {
      const absPath = path.join(repoRoot, block.file);
      if (!existsSync(absPath)) continue; // the file itself is gone — nothing left to check

      const content = readFileSync(absPath, 'utf8');
      const currentBlocks = scanAiImplementationBlocks(block.file, content);
      // Match on the block's ordinal among all blocks in its file (recorded at
      // generate time). Line numbers drift the moment an earlier block is
      // filled, and the pending list is only a subset of the file's blocks, so
      // neither line nor pending-list position is a reliable key. Fall back to
      // the recorded start line only if the block count changed.
      const match = currentBlocks[block.blockIndex] ?? currentBlocks.find((b) => b.startLine === block.startLine);
      const stillPlaceholder = match !== undefined && match.content.trim() === block.placeholderContent.trim();

      if (!match || stillPlaceholder) {
        unresolved.push({ file: block.file, startLine: block.startLine + 1, endLine: block.endLine + 1 });
        anyUnresolvedInRecord = true;
      }
    }

    if (!anyUnresolvedInRecord) removePendingRecord(repoRoot, record.changesetId);
  }

  return { resolvedAll: unresolved.length === 0, unresolved };
}
