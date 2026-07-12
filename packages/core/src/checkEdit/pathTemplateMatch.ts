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
 *
 * `resolveTemplatePattern` generalizes this for brownfield adoption: given a
 * pack slot's persisted `companyProjectName`/`pathConfig` (see
 * `config/schema.ts`'s `PackConfig`), those two known placeholder families
 * resolve to their literal string instead of a wildcard, so the regex
 * reflects the repo's *real* directory layout rather than always accepting
 * any segment. A bare `{{entity}}` still can't be resolved this way (it's
 * per-manifest, not per-repo), but is worth naming: its first occurrence
 * becomes the named group `(?<entity>[^/]+)` so a caller (the descriptor
 * mapper) can recover which entity a matched path belongs to; every
 * subsequent bare `{{entity}}` in the same template backreferences that
 * group with `\k<entity>` rather than declaring a second same-named group
 * (which JS regex forbids) — this also correctly requires every occurrence
 * of entity in one path to agree, matching what a real render would produce.
 * `templateToRegex` is the zero-context special case of this, kept as its
 * own export since it's the common case and the existing public API.
 *
 * A resolved `pathConfig` value is allowed to itself contain `/` and `..`
 * segments (e.g. `apiControllers: "../../Services"`, escaping a pack's
 * hardcoded `src/*.Api/` prefix to point at a brownfield repo's real
 * `Services/` directory) — the same convention `generate.ts`'s real
 * Handlebars-rendered-then-`path.join`-resolved output paths already accept.
 * To honor that here too, resolution runs in three passes: (1) build one
 * flat string substituting resolved placeholders with their literal value
 * verbatim (which may itself expand into several `/`-separated segments)
 * and unresolved placeholders with an opaque sentinel token; (2) split on
 * `/` and collapse `.`/`..` segments exactly as `path.join` would — a `..`
 * that would need to collapse into a still-unresolved (sentinel) segment,
 * or past the start of the path, is left as a literal `..` instead, which
 * can never match a real repo-relative path (never starts with `..`), so it
 * fails safe rather than resolving wrong; (3) escape literal text and
 * splice each sentinel back in as its regex fragment.
 */

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;
const PATH_CONFIG_KEY_RE = /^pathConfig\.(\S+)$/;
/** A Unicode Private Use Area code point (``) delimits each sentinel — printable-safe (unlike a NUL byte, which trips git/tooling's binary-file heuristics) and never appears in real template text. */
const SENTINEL_PREFIX = 'P';
const SENTINEL_SUFFIX = '';
const SENTINEL_RE = new RegExp(`(${SENTINEL_PREFIX}\\d+${SENTINEL_SUFFIX})`);

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface TemplateResolutionContext {
  companyProjectName?: string;
  pathConfig?: Record<string, string>;
}

export function resolveTemplatePattern(template: string, context: TemplateResolutionContext = {}): RegExp {
  // Pass 1: one flat string, resolved placeholders substituted verbatim,
  // unresolved ones replaced by an opaque sentinel standing in for their
  // eventual regex fragment (recorded in `sentinelFragments`).
  const sentinelFragments = new Map<string, string>();
  let entityGroupDeclared = false;
  let raw = '';
  let lastIndex = 0;
  let sentinelIndex = 0;

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const index = match.index ?? 0;
    raw += template.slice(lastIndex, index);

    const inner = match[0].slice(2, -2).trim();
    const pathConfigKey = PATH_CONFIG_KEY_RE.exec(inner)?.[1];

    if (inner === 'companyProjectName' && context.companyProjectName !== undefined) {
      raw += context.companyProjectName;
    } else if (pathConfigKey !== undefined && context.pathConfig?.[pathConfigKey] !== undefined) {
      raw += context.pathConfig[pathConfigKey];
    } else {
      let fragment = '[^/]+';
      if (inner === 'entity') {
        fragment = entityGroupDeclared ? '\\k<entity>' : '(?<entity>[^/]+)';
        entityGroupDeclared = true;
      }
      const sentinel = `${SENTINEL_PREFIX}${sentinelIndex++}${SENTINEL_SUFFIX}`;
      sentinelFragments.set(sentinel, fragment);
      raw += sentinel;
    }

    lastIndex = index + match[0].length;
  }
  raw += template.slice(lastIndex);

  // Pass 2: collapse `.`/`..` segments the way `path.join` would, now that
  // any pathConfig-supplied relative escape is real text in `raw`.
  const normalized: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      const prev = normalized[normalized.length - 1];
      if (prev !== undefined && prev !== '..' && !prev.includes(SENTINEL_PREFIX)) {
        normalized.pop();
        continue;
      }
    }
    normalized.push(segment);
  }

  // Pass 3: escape literal text, splice sentinels back in as regex fragments.
  const pattern = normalized
    .map((segment) =>
      segment
        .split(SENTINEL_RE)
        .map((piece) => sentinelFragments.get(piece) ?? escapeRegExpLiteral(piece))
        .join(''),
    )
    .join('/');

  return new RegExp(`^${pattern}$`);
}

export function templateToRegex(template: string): RegExp {
  return resolveTemplatePattern(template);
}

export function pathMatchesTemplate(relPath: string, template: string): boolean {
  return templateToRegex(template).test(relPath);
}
