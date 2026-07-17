/**
 * Extension -> {start, end} comment-syntax table, plus per-injection
 * override resolution **and** per-pack extension map resolution. The
 * injector needs the actual comment syntax per target file to render a
 * logical `marker` ID (e.g. SCAFFOLD_DI) into real start/end tags;
 * `marker` itself stays a stable logical ID so the same descriptor
 * works whether the target file uses `//`, `#`, or `<!-- -->` comments.
 *
 * **Resolution precedence** (highest wins):
 *
 * 1. Per-injection `override` (the canonical `{ start, end }` shape on
 *    a descriptor `injections[]` entry — the existing escape hatch for
 *    edge cases the table doesn't cover).
 * 2. Pack-level `packSyntaxMap[ext]` (new): the descriptor's
 *    `commentSyntax` field, keyed by lower-cased file extension. Each
 *    value is either `{ prefix }` (rendered as `<prefix> SCAFFOLD:<m>:START/END`,
 *    mirroring the built-in TABLE format) or `{ wrap: [open, close] }`
 *    (rendered as `<open>SCAFFOLD:<m>:START<close>`, mirroring the
 *    HTML-style built-in `TABLE` rule). The pack-level map lets a pack
 *    cover many extensions without per-injection overrides.
 * 3. Built-in `TABLE` (the existing hardcoded extension list).
 * 4. Hard error — naming the file and suggesting either an explicit
 *    per-injection `commentSyntax: { start, end }` override or a
 *    pack-level `commentSyntax` map entry for the same extension.
 */

import path from 'node:path';
import type { CommentSyntaxOverride, PackCommentSyntaxMap } from '../descriptor/schema.js';

export interface ResolvedMarkerSyntax {
  startLine: string;
  endLine: string;
}

interface SyntaxRule {
  extensions: string[];
  start: (marker: string) => string;
  end: (marker: string) => string;
}

const TABLE: SyntaxRule[] = [
  {
    extensions: ['.cs', '.ts', '.tsx', '.js', '.jsx', '.java', '.go', '.rs'],
    start: (marker) => `// SCAFFOLD:${marker}:START`,
    end: (marker) => `// SCAFFOLD:${marker}:END`,
  },
  {
    extensions: ['.py', '.rb', '.sh', '.yml', '.yaml'],
    start: (marker) => `# SCAFFOLD:${marker}:START`,
    end: (marker) => `# SCAFFOLD:${marker}:END`,
  },
  {
    extensions: ['.html', '.xml', '.vue'],
    start: (marker) => `<!-- SCAFFOLD:${marker}:START -->`,
    end: (marker) => `<!-- SCAFFOLD:${marker}:END -->`,
  },
];

/**
 * Renders a pack-level `commentSyntax[ext]` entry into the same
 * `{ startLine, endLine }` shape used everywhere downstream. A
 * `{ prefix }` entry produces `<p> SCAFFOLD:<m>:START` / `<p> SCAFFOLD:<m>:END`,
 * mirroring the two-row built-in TABLE rules. A `{ wrap: [a, b] }` entry
 * produces `<a>SCAFFOLD:<m>:START<b>` / `<a>SCAFFOLD:<m>:END<b>`,
 * mirroring the HTML-shaped built-in TABLE rule. Any garbage in the
 * entry shape is the descriptor schema's job (ajv) to reject, not this
 * function's; if a malformed entry somehow reaches here we still throw,
 * never silently coerce.
 */
function renderPackSyntaxEntry(entry: unknown, marker: string, ext: string): ResolvedMarkerSyntax {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(
      `pack commentSyntax entry for "${ext}" must be an object with either {prefix} or {wrap: [open, close]} — got ${typeof entry}`,
    );
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.prefix === 'string') {
    const prefix = obj.prefix;
    return {
      startLine: `${prefix} SCAFFOLD:${marker}:START`,
      endLine: `${prefix} SCAFFOLD:${marker}:END`,
    };
  }
  if (Array.isArray(obj.wrap) && obj.wrap.length === 2 && obj.wrap.every((v) => typeof v === 'string')) {
    const [open, close] = obj.wrap as [string, string];
    return {
      startLine: `${open}SCAFFOLD:${marker}:START${close}`,
      endLine: `${open}SCAFFOLD:${marker}:END${close}`,
    };
  }
  throw new Error(
    `pack commentSyntax entry for "${ext}" must be {prefix: string} or {wrap: [string, string]} — got ${JSON.stringify(entry)}`,
  );
}

/**
 * A target file whose extension has no table entry, no pack-level map
 * entry, and no per-injection override is a hard error naming the file
 * and suggesting an explicit `commentSyntax: {start, end}` override or
 * a pack-level `commentSyntax` map entry for the same extension —
 * rather than guessing at a syntax that could corrupt the file.
 */
export function resolveMarkerSyntax(
  filePath: string,
  marker: string,
  override?: CommentSyntaxOverride,
  packSyntaxMap?: PackCommentSyntaxMap,
): ResolvedMarkerSyntax {
  if (override) {
    return { startLine: override.start, endLine: override.end };
  }

  const ext = path.extname(filePath).toLowerCase();
  if (packSyntaxMap !== undefined && Object.prototype.hasOwnProperty.call(packSyntaxMap, ext)) {
    return renderPackSyntaxEntry(packSyntaxMap[ext], marker, ext);
  }

  const rule = TABLE.find((r) => r.extensions.includes(ext));
  if (!rule) {
    throw new Error(
      `no known comment syntax for "${filePath}" (extension "${ext}") — add an explicit commentSyntax: {start, end} override to this injection's descriptor entry, or declare "${ext}" in the pack's commentSyntax map`,
    );
  }
  return { startLine: rule.start(marker), endLine: rule.end(marker) };
}

export function buildHashTrailerLine(hashTrailerPrefix: string, hex: string): string {
  return `${hashTrailerPrefix}${hex}`;
}
