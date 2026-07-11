/**
 * `scaffold check-edit --file <path> --tool <write|edit> [--old-string <text>|--old-string-file <path>]`:
 * the structural gate both host adapters' PreToolUse hooks shell out to
 * before a Write/Edit tool call is allowed to run. Purely structural — no
 * session-state tracking, no content/keyword intent detection (per the
 * user's final decision recorded in the plan): the only inputs are the
 * repo's own `.scaffold/config.json` + synced pack descriptors, plus the
 * one proposed edit.
 *
 * Algorithm (mirrors the plan verbatim):
 *   1. No `.scaffold/config.json` → allow. A non-scaffold repo is a total
 *      no-op, zero added cost.
 *   2. Path resolves outside the repo root → allow. It can't match a
 *      repo-relative pack pattern, and this isn't an error condition — a
 *      host agent legitimately edits files outside the repo sometimes.
 *   3. No configured pack's `targets[].output` / `injections[].file`
 *      pattern matches the path → allow, `packOwned: false`. This is the
 *      common case (docs, tests, unrelated business logic) and stays cheap.
 *   4. Matched, `tool: write` → always block. Creating or overwriting a
 *      pack-owned file must go through `scaffold generate`.
 *   5. Matched, `tool: edit` → allow only if `old_string` resolves to
 *      exactly one occurrence in the file AND that occurrence's full byte
 *      range sits inside one AI_IMPLEMENTATION block's interior (using the
 *      offsets markerScan.ts now computes for every block). Landing in a
 *      `SCAFFOLD:<marker>` injection region, or anywhere else in the file,
 *      blocks. `old_string` missing, not found, or found more than once
 *      blocks with a distinct "ambiguous" reason — fail-closed rather than
 *      guessing which occurrence the caller meant.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { configExists, loadConfig } from '../config/loader.js';
import { defaultCacheRoot } from '../templates/sync.js';
import { scanAiImplementationBlocks } from '../generate/markerScan.js';
import { collectPackOwnership, matchOwnership } from './collectPackOwnership.js';

export type CheckEditTool = 'write' | 'edit';

export type CheckEditReason =
  | 'no-config'
  | 'outside-repo'
  | 'not-pack-owned'
  | 'write-blocked'
  | 'edit-allowed-in-interior'
  | 'edit-blocked-outside-interior'
  | 'edit-blocked-ambiguous-old-string';

export interface CheckEditOptions {
  repoRoot: string;
  file: string;
  tool: CheckEditTool;
  oldString?: string;
  cacheRoot?: string;
}

export interface CheckEditResult {
  allow: boolean;
  reason: CheckEditReason;
  detail: string;
  packOwned: boolean;
  packSlot?: string;
}

/** Lexical outside-repo-root check (no symlink resolution — check-edit reads, it never writes, so pathGuard.ts's stricter symlink-aware guard is unnecessary weight here). */
function resolvesOutsideRepoRoot(repoRoot: string, absPath: string): boolean {
  const relative = path.relative(repoRoot, absPath);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function toPosixRelPath(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function checkEdit(options: CheckEditOptions): CheckEditResult {
  const repoRoot = path.resolve(options.repoRoot);

  if (!configExists(repoRoot)) {
    return { allow: true, reason: 'no-config', detail: 'no .scaffold/config.json in this repo — check-edit is a no-op', packOwned: false };
  }

  const absPath = path.resolve(repoRoot, options.file);
  if (resolvesOutsideRepoRoot(repoRoot, absPath)) {
    return { allow: true, reason: 'outside-repo', detail: `${options.file} resolves outside the repo root — not a pack-ownership concern`, packOwned: false };
  }
  const relPath = toPosixRelPath(path.relative(repoRoot, absPath));

  const config = loadConfig(repoRoot);
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(repoRoot);
  const matchers = collectPackOwnership(config, cacheRoot);
  const match = matchOwnership(matchers, relPath);

  if (!match) {
    return { allow: true, reason: 'not-pack-owned', detail: `${relPath} is not declared by any configured (and synced) pack's targets/injections`, packOwned: false };
  }

  if (options.tool === 'write') {
    return {
      allow: false,
      reason: 'write-blocked',
      detail: `${relPath} is owned by pack "${match.packSlot}" (${match.kind} "${match.template}") — creating or overwriting it must go through "scaffold generate", not a direct write`,
      packOwned: true,
      packSlot: match.packSlot,
    };
  }

  // options.tool === 'edit'
  if (options.oldString === undefined || options.oldString.length === 0) {
    return {
      allow: false,
      reason: 'edit-blocked-ambiguous-old-string',
      detail: `no old_string given for an edit to pack-owned file ${relPath} — refusing to guess, fail-closed`,
      packOwned: true,
      packSlot: match.packSlot,
    };
  }

  if (!existsSync(absPath)) {
    return {
      allow: false,
      reason: 'write-blocked',
      detail: `${relPath} is owned by pack "${match.packSlot}" but does not exist on disk yet — run "scaffold generate" to create it first`,
      packOwned: true,
      packSlot: match.packSlot,
    };
  }

  const content = readFileSync(absPath, 'utf8');
  const occurrences = countOccurrences(content, options.oldString);
  if (occurrences !== 1) {
    return {
      allow: false,
      reason: 'edit-blocked-ambiguous-old-string',
      detail: occurrences === 0
        ? `old_string was not found in ${relPath} — refusing to guess, fail-closed`
        : `old_string appears ${occurrences} times in ${relPath} — ambiguous, refusing to guess, fail-closed`,
      packOwned: true,
      packSlot: match.packSlot,
    };
  }

  const startOffset = content.indexOf(options.oldString);
  const endOffset = startOffset + options.oldString.length;

  let blocks;
  try {
    blocks = scanAiImplementationBlocks(relPath, content);
  } catch {
    // A file whose AI_IMPLEMENTATION markers are themselves malformed can't
    // be structurally verified one way or the other — fail closed, same as
    // an ambiguous old_string, rather than silently allowing.
    return {
      allow: false,
      reason: 'edit-blocked-outside-interior',
      detail: `${relPath} could not be scanned for AI_IMPLEMENTATION blocks (malformed markers) — refusing the edit, fail-closed`,
      packOwned: true,
      packSlot: match.packSlot,
    };
  }

  const containingBlock = blocks.find((b) => startOffset >= b.interiorStartOffset && endOffset <= b.interiorEndOffset);
  if (containingBlock) {
    return {
      allow: true,
      reason: 'edit-allowed-in-interior',
      detail: `edit falls entirely within an AI_IMPLEMENTATION interior in ${relPath}`,
      packOwned: true,
      packSlot: match.packSlot,
    };
  }

  return {
    allow: false,
    reason: 'edit-blocked-outside-interior',
    detail: `${relPath} is owned by pack "${match.packSlot}" (${match.kind} "${match.template}") — edits outside an AI_IMPLEMENTATION interior (e.g. a SCAFFOLD:<marker> injection region) must go through "scaffold generate"`,
    packOwned: true,
    packSlot: match.packSlot,
  };
}
