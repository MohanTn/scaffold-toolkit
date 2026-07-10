/**
 * Marker locate/validate/inject/hash-check engine. Multi-marker-per-file
 * injection is a single-pass rebuild, not sequential patches: markerScan.ts
 * scans the *original* file content once, recording every marker pair's
 * byte offsets in that unmodified content; this module then builds the
 * entire new file content in one string-replacement pass over those
 * original offsets, working outward from a single source string. This makes
 * injection order irrelevant by construction — the two-independent-markers-
 * in-one-file fixture (Program.cs's SCAFFOLD_DI and SCAFFOLD_ROUTES) relies
 * on exactly this property.
 *
 * Idempotent by per-marker content hash: a hash trailer line inside each
 * marker's interior region records a sha256 of the rendered content last
 * written there. Re-rendering the same manifest+template produces the same
 * hash, so a repeat run recognizes "nothing changed" and leaves those bytes
 * untouched (byte-identical output). A different hash — either because the
 * template/manifest changed, or because a human hand-edited the block —
 * means refuse unless `--force`.
 */

import { createHash } from 'node:crypto';
import { scanMarkers } from './markerScan.js';
import type { MarkerLocation } from './markerScan.js';
import { resolveMarkerSyntax } from './commentSyntax.js';
import type { CommentSyntaxOverride, PackCommentSyntaxMap } from '../descriptor/schema.js';

export interface InjectionRequest {
  marker: string;
  renderedContent: string;
  hashTrailerPrefix: string;
  position: 'before-end' | 'after-start';
  strategy: 'replace' | 'append';
  commentSyntaxOverride?: CommentSyntaxOverride;
  /** Pack-level comment-syntax map; consulted by resolveMarkerSyntax before the built-in TABLE. */
  packSyntaxMap?: PackCommentSyntaxMap;
}

export interface InjectionOutcome {
  marker: string;
  action: 'unchanged' | 'created' | 'updated';
}

export class InjectionRefusedError extends Error {
  constructor(
    public readonly file: string,
    public readonly marker: string,
    public readonly before: string,
    public readonly after: string,
  ) {
    super(
      `${file}: marker "${marker}" content differs from what was previously injected — refusing without --force\n` +
        `--- previously injected ---\n${before}\n--- newly rendered ---\n${after}`,
    );
  }
}

export interface InjectResult {
  content: string;
  outcomes: InjectionOutcome[];
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Splits an interior's lines into {existing hash trailer hex, remaining content lines}, or no hex if no trailer line is present. */
function extractExistingHash(interiorLines: string[], hashTrailerPrefix: string): { hex?: string; contentLines: string[] } {
  const trailerIdx = interiorLines.findIndex((l) => l.trim().startsWith(hashTrailerPrefix));
  if (trailerIdx === -1) return { contentLines: interiorLines };
  const hex = interiorLines[trailerIdx].trim().slice(hashTrailerPrefix.length).trim();
  const contentLines = interiorLines.filter((_, i) => i !== trailerIdx);
  return { hex, contentLines };
}

function buildInteriorLines(request: InjectionRequest, trailerLine: string): string[] {
  const contentLines = request.renderedContent.split('\n');
  return request.position === 'after-start' ? [trailerLine, ...contentLines] : [...contentLines, trailerLine];
}

function interiorText(lines: string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function stripTrailingEmptyLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop();
  return out;
}

/** True when `needle`'s trimmed lines appear as one contiguous run inside `haystack`'s trimmed lines. */
function containsContiguousLines(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  const h = haystack.map((l) => l.trim());
  const n = needle.map((l) => l.trim());
  outer: for (let i = 0; i + n.length <= h.length; i += 1) {
    for (let j = 0; j < n.length; j += 1) {
      if (h[i + j] !== n[j]) continue outer;
    }
    return true;
  }
  return false;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

/** Rebuilds `original` in one pass by splicing each replacement's text over its own [start, end) offset range, all computed against the same unmodified `original` string. */
function rebuildContent(original: string, replacements: Replacement[]): string {
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const r of sorted) {
    result += original.slice(cursor, r.start);
    result += r.text;
    cursor = r.end;
  }
  result += original.slice(cursor);
  return result;
}

/**
 * Injects every request into `originalContent` in one pass. Throws
 * InjectionRefusedError (before returning anything) the moment any marker's
 * existing, non-empty interior content hashes differently from what would
 * be written now and `force` is false — the caller is expected to not write
 * anything for this file (or this whole generate run) when that happens.
 */
export function injectMarkers(filePath: string, originalContent: string, requests: InjectionRequest[], force: boolean): InjectResult {
  const scanRequests = requests.map((request) => {
    const syntax = resolveMarkerSyntax(filePath, request.marker, request.commentSyntaxOverride, request.packSyntaxMap);
    return { marker: request.marker, startLine: syntax.startLine, endLine: syntax.endLine };
  });
  const locations: Map<string, MarkerLocation> = scanMarkers(filePath, originalContent, scanRequests);
  const lines = originalContent.split('\n');

  const replacements: Replacement[] = [];
  const outcomes: InjectionOutcome[] = [];

  for (const request of requests) {
    const location = locations.get(request.marker)!;
    const interiorLines = lines.slice(location.startLineIndex + 1, location.endLineIndex);
    const isEmpty = interiorLines.every((l) => l.trim().length === 0);
    const { hex: existingHex, contentLines: existingContentLines } = extractExistingHash(interiorLines, request.hashTrailerPrefix);
    const newHash = contentHash(request.renderedContent);

    if (existingHex === newHash) {
      outcomes.push({ marker: request.marker, action: 'unchanged' });
      replacements.push({
        start: location.interiorStartOffset,
        end: location.interiorEndOffset,
        text: originalContent.slice(location.interiorStartOffset, location.interiorEndOffset),
      });
      continue;
    }

    if (request.strategy === 'append' && !isEmpty) {
      const snippetLines = stripTrailingEmptyLines(request.renderedContent.split('\n'));
      if (containsContiguousLines(existingContentLines, snippetLines)) {
        outcomes.push({ marker: request.marker, action: 'unchanged' });
        replacements.push({
          start: location.interiorStartOffset,
          end: location.interiorEndOffset,
          text: originalContent.slice(location.interiorStartOffset, location.interiorEndOffset),
        });
        continue;
      }
      const existingText = existingContentLines.join('\n');
      if (existingHex !== contentHash(existingText) && !force) {
        throw new InjectionRefusedError(filePath, request.marker, existingText, request.renderedContent);
      }
      const accumulatedText = `${[...stripTrailingEmptyLines(existingContentLines), ...snippetLines].join('\n')}\n`;
      const appendTrailerLine = `${request.hashTrailerPrefix}${contentHash(accumulatedText)}`;
      const appendInteriorText = interiorText(buildInteriorLines({ ...request, renderedContent: accumulatedText }, appendTrailerLine));
      outcomes.push({ marker: request.marker, action: 'updated' });
      replacements.push({ start: location.interiorStartOffset, end: location.interiorEndOffset, text: appendInteriorText });
      continue;
    }

    const trailerLine = `${request.hashTrailerPrefix}${newHash}`;
    const newInteriorText = interiorText(buildInteriorLines(request, trailerLine));

    if (!isEmpty && !force) {
      throw new InjectionRefusedError(filePath, request.marker, existingContentLines.join('\n'), request.renderedContent);
    }

    outcomes.push({ marker: request.marker, action: isEmpty ? 'created' : 'updated' });
    replacements.push({ start: location.interiorStartOffset, end: location.interiorEndOffset, text: newInteriorText });
  }

  return { content: rebuildContent(originalContent, replacements), outcomes };
}
