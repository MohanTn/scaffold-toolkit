/**
 * Reverse-matches a concrete repo-relative file path against a template
 * pack's Handlebars-templated `targets[].output` / `injections[].file`
 * string, without a manifest — `scaffold check-edit` runs before any intent
 * manifest exists, so there's no `entity` value to render the template with.
 * Every `{{...}}` placeholder (bare, e.g. `{{entity}}`, or helper-wrapped,
 * e.g. `{{pascal entity}}`) becomes a `[^/]+` capture: scaffold-toolkit path
 * templates only ever substitute a single path *segment name* per
 * placeholder, never a `/`-containing value, so the regex doesn't need to
 * know which Handlebars helper (if any) produced the value — just that it
 * occupies a stretch of one path segment.
 */

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function templateToRegex(template: string): RegExp {
  let pattern = '';
  let lastIndex = 0;
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const index = match.index ?? 0;
    pattern += escapeRegExpLiteral(template.slice(lastIndex, index));
    pattern += '[^/]+';
    lastIndex = index + match[0].length;
  }
  pattern += escapeRegExpLiteral(template.slice(lastIndex));
  return new RegExp(`^${pattern}$`);
}

export function pathMatchesTemplate(relPath: string, template: string): boolean {
  return templateToRegex(template).test(relPath);
}
