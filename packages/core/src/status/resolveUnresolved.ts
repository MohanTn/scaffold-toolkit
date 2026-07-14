/**
 * Shared rescan-and-match logic behind `scaffold status` and `scaffold
 * next`: re-scans every tracked .scaffold/pending/*.json file, matches each
 * recorded block against the file's current AI_IMPLEMENTATION blocks (by
 * ordinal, falling back to start line), and decides whether it's still
 * unresolved. A fully-resolved record is pruned as a side effect, exactly as
 * `scaffold status` has always done — `scaffold next` reuses this same
 * rescan rather than duplicating it, so the two commands can never disagree
 * about what's still open.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { listPendingRecords, removePendingRecord } from '../generate/pendingTracker.js';
import { scanAiImplementationBlocks } from '../generate/markerScan.js';

export interface UnresolvedBlockDetail {
  file: string;
  startLine: number;
  endLine: number;
  /** The block's current interior content — the still-unfilled placeholder body. */
  content: string;
  required: boolean;
  /** The pack slot/version this block's record was generated against (see PendingRecord); absent for a record written before these fields existed. */
  packSlot?: string;
  packVersion?: string;
}

export function scanUnresolvedBlocks(repoRoot: string): UnresolvedBlockDetail[] {
  const unresolved: UnresolvedBlockDetail[] = [];

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
        unresolved.push({
          file: block.file,
          startLine: block.startLine + 1,
          endLine: block.endLine + 1,
          content: match?.content ?? block.placeholderContent,
          required: match?.required ?? false,
          packSlot: record.packSlot,
          packVersion: record.packVersion,
        });
        anyUnresolvedInRecord = true;
      }
    }

    if (!anyUnresolvedInRecord) removePendingRecord(repoRoot, record.changesetId);
  }

  return unresolved;
}
