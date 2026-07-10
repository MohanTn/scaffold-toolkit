/**
 * Single-pass marker-pair scanner over ORIGINAL file content (byte offsets,
 * file+line-number aware). Scans once per file for every requested marker
 * pair and records each pair's offsets in the unmodified content; injector.ts
 * then builds the entire new file content in one string-replacement pass
 * over those original offsets, working outward from a single source string
 * and never re-reading the file mid-injection. This is what makes injection
 * order irrelevant by construction, rather than relying on a convention
 * like "process in descending line order."
 *
 * Exactly one occurrence of a marker start/end pair is expected per file per
 * marker ID; zero, one-sided, or duplicate occurrences are hard errors that
 * include the file path and line number.
 */

export interface MarkerRequest {
  marker: string;
  startLine: string;
  endLine: string;
}

export interface MarkerLocation {
  marker: string;
  startLineIndex: number;
  endLineIndex: number;
  /** Char offset of the first line *after* the START line — where the interior region begins. */
  interiorStartOffset: number;
  /** Char offset of the first char of the END line — where the interior region ends. */
  interiorEndOffset: number;
}

export class MarkerScanError extends Error {}

function buildLineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1; // +1 for the '\n' joining this line to the next
  }
  return offsets;
}

export function scanMarkers(filePath: string, content: string, requests: MarkerRequest[]): Map<string, MarkerLocation> {
  const lines = content.split('\n');
  const lineOffsets = buildLineOffsets(lines);

  const startHits = new Map<string, number[]>();
  const endHits = new Map<string, number[]>();
  for (const request of requests) {
    startHits.set(request.marker, []);
    endHits.set(request.marker, []);
  }

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    for (const request of requests) {
      if (trimmed === request.startLine.trim()) startHits.get(request.marker)!.push(idx);
      if (trimmed === request.endLine.trim()) endHits.get(request.marker)!.push(idx);
    }
  });

  const result = new Map<string, MarkerLocation>();
  for (const request of requests) {
    const starts = startHits.get(request.marker)!;
    const ends = endHits.get(request.marker)!;

    if (starts.length === 0 && ends.length === 0) {
      throw new MarkerScanError(
        `${filePath}: marker "${request.marker}" not found (expected a "${request.startLine}" / "${request.endLine}" pair)`,
      );
    }
    if (starts.length === 0) {
      throw new MarkerScanError(`${filePath}:${ends[0] + 1}: marker "${request.marker}" is one-sided — found END but no START`);
    }
    if (ends.length === 0) {
      throw new MarkerScanError(`${filePath}:${starts[0] + 1}: marker "${request.marker}" is one-sided — found START but no END`);
    }
    if (starts.length > 1) {
      throw new MarkerScanError(
        `${filePath}:${starts.map((i) => i + 1).join(',')}: marker "${request.marker}" START appears ${starts.length} times, expected exactly once`,
      );
    }
    if (ends.length > 1) {
      throw new MarkerScanError(
        `${filePath}:${ends.map((i) => i + 1).join(',')}: marker "${request.marker}" END appears ${ends.length} times, expected exactly once`,
      );
    }

    const startLineIndex = starts[0];
    const endLineIndex = ends[0];
    if (endLineIndex <= startLineIndex) {
      throw new MarkerScanError(`${filePath}:${startLineIndex + 1}: marker "${request.marker}" END (line ${endLineIndex + 1}) appears before its START`);
    }

    result.set(request.marker, {
      marker: request.marker,
      startLineIndex,
      endLineIndex,
      interiorStartOffset: lineOffsets[startLineIndex + 1],
      interiorEndOffset: lineOffsets[endLineIndex],
    });
  }
  return result;
}

export interface AiImplementationBlock {
  id?: string;
  startLine: number;
  endLine: number;
  content: string;
  empty: boolean;
}

// Both spellings pack authors use in the wild: `AI_IMPLEMENTATION_START`
// (react packs) and `SCAFFOLD:AI_IMPLEMENTATION:START` (dotnet packs).
const START_RE = /AI_IMPLEMENTATION[_:]START(?::\s*(\S+))?/;
const END_RE = /AI_IMPLEMENTATION[_:]END(?::\s*(\S+))?/;

/**
 * Scans for AI_IMPLEMENTATION_START/END phase-3 fill-in blocks. These are
 * literal text a pack author writes directly into a .hbs template in
 * whatever comment syntax matches that file type — the engine only ever
 * reads this marker family (to build the report) and never writes into it,
 * so it doesn't need commentSyntax.ts's per-extension table; it just scans
 * for the reserved substring.
 */
export function scanAiImplementationBlocks(filePath: string, content: string): AiImplementationBlock[] {
  const lines = content.split('\n');
  const blocks: AiImplementationBlock[] = [];
  const stack: { id?: string; startLine: number }[] = [];

  lines.forEach((line, idx) => {
    const startMatch = START_RE.exec(line);
    if (startMatch) {
      stack.push({ id: startMatch[1], startLine: idx });
      return;
    }
    const endMatch = END_RE.exec(line);
    if (endMatch) {
      const open = stack.pop();
      if (!open) {
        throw new Error(`${filePath}:${idx + 1}: AI_IMPLEMENTATION_END with no matching START`);
      }
      if (open.id && endMatch[1] && open.id !== endMatch[1]) {
        throw new Error(
          `${filePath}:${idx + 1}: AI_IMPLEMENTATION_END id "${endMatch[1]}" does not match START id "${open.id}" at line ${open.startLine + 1}`,
        );
      }
      const innerLines = lines.slice(open.startLine + 1, idx);
      blocks.push({
        id: open.id ?? endMatch[1],
        startLine: open.startLine,
        endLine: idx,
        content: innerLines.join('\n'),
        empty: innerLines.every((l) => l.trim().length === 0),
      });
    }
  });

  if (stack.length > 0) {
    throw new Error(`${filePath}:${stack[0].startLine + 1}: AI_IMPLEMENTATION_START with no matching END`);
  }
  return blocks.sort((a, b) => a.startLine - b.startLine);
}
