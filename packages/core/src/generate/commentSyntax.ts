/**
 * Extension -> {start, end} comment-syntax table, plus per-injection
 * override resolution. The injector needs the actual comment syntax per
 * target file to render a logical `marker` ID (e.g. SCAFFOLD_DI) into real
 * start/end tags; `marker` itself stays a stable logical ID so the same
 * descriptor works whether the target file uses `//`, `#`, or `<!-- -->`
 * comments.
 */

import path from 'node:path';
import type { CommentSyntaxOverride } from '../descriptor/schema.js';

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
 * A target file whose extension has no table entry and no override is a
 * hard error naming the file and suggesting an explicit `commentSyntax`
 * override, rather than guessing at a syntax that could corrupt the file.
 */
export function resolveMarkerSyntax(filePath: string, marker: string, override?: CommentSyntaxOverride): ResolvedMarkerSyntax {
  if (override) {
    return { startLine: override.start, endLine: override.end };
  }

  const ext = path.extname(filePath).toLowerCase();
  const rule = TABLE.find((r) => r.extensions.includes(ext));
  if (!rule) {
    throw new Error(
      `no known comment syntax for "${filePath}" (extension "${ext}") — add an explicit commentSyntax: {start, end} override to this injection's descriptor entry`,
    );
  }
  return { startLine: rule.start(marker), endLine: rule.end(marker) };
}

export function buildHashTrailerLine(hashTrailerPrefix: string, hex: string): string {
  return `${hashTrailerPrefix}${hex}`;
}
