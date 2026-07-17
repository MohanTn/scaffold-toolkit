/**
 * ajv JSON Schema v2 for a template pack's manifest.templates.json.
 *
 * The root object allows unknown top-level fields (additionalProperties:
 * true) so a newer pack using a CLI-version field this engine doesn't yet
 * know about doesn't hard-fail; each targets[]/injections[] entry keeps
 * additionalProperties:false with its own required list, so typos in known
 * fields are still caught.
 *
 * **Documentation fields (`_`-prefixed) on every entry-level schema.**
 * Each per-entry schema declares `additionalProperties: false` to catch
 * real typos (e.g. `outpu` instead of `output`) but pairs that with
 * `patternProperties: { '^_': true }` so a pack author can add `_comment`,
 * `_notes`, `_deprecated_at`, etc. without the schema hard-failing. The
 * engine never reads underscore-prefixed fields, so this is purely a
 * documentation allowance — no runtime stripping is needed. This matches
 * the standard convention of `x-`-prefixed extension fields in OpenAPI
 * / Swagger documents, just with the `_` prefix instead.
 *
 * `marker` rejects any value starting with "AI_IMPLEMENTATION", reserving
 * that namespace so a pack author can never accidentally collide a real
 * injection marker with the phase-3 fill-in region.
 *
 * **Three new optional fields make the engine pack-driven across
 * languages and architectures:**
 *
 * - `inputs`: declares the input vocabulary the pack actually needs
 *   (`entity` + `fields[]` for dotnet; `aggregate` + a different shape
 *   for something else). The base intent-manifest schema no longer hard-
 *   requires `entity`/`fields`; each pack declares its own contract and
 *   `manifest/inputValidation.ts` enforces it after the descriptor loads.
 *   A descriptor omitting `inputs` keeps today's strict PascalCase
 *   `entity` + non-empty `fields[]` legacy contract — existing dotnet
 *   packs unchanged.
 *
 * - `commentSyntax` (pack-level): a record of file extension → either
 *   `{ prefix }` (e.g. `--` for SQL) or `{ wrap: [open, close] }` (e.g.
 *   for Razor). Resolved by `generate/commentSyntax.ts`'s
 *   `resolveMarkerSyntax` with precedence: per-injection override →
 *   pack map → built-in TABLE → hard error. Per-injection `commentSyntax`
 *   still works as before; packs only need the pack-level map when they
 *   target extensions that don't fit the built-in table.
 *
 * - `bootstrapAnchors`: lets any pack declare where its brownfield
 *   markers belong, instead of being written only for the four dotnet
 *   versions `bootstrapMarkers/anchorCatalog.ts` hardcodes. The hardcoded
 *   `ANCHOR_CATALOG` is kept as a built-in fallback so before-pack-declared
 *   dotnet keeps working byte-for-byte.
 */

/** `^_` key pattern + empty-object schema (`{}` = match anything): any property whose name starts with `_` is permitted (no shape check), as a pack-author documentation allowance. The empty-object form is preferred over the boolean `true` shorthand for stricter cross-ajv portability (some ajv modes and forks reject boolean schemas). */
const docFieldPattern = { '^_': {} } as const;

/**
 * `artifact`/`when` (optional, on targets and injections) drive selective
 * generation, see `generate/entryFilter.ts`:
 *
 * - `artifact`: a kebab-case tag grouping the entry under a named artifact
 *   (e.g. `op-create`, `domain-event`). A manifest carrying `artifacts:
 *   [...]` renders only entries whose tag (untagged ⇒ the pseudo-tag
 *   `base`) is listed; a manifest without `artifacts` renders everything,
 *   byte-identical to the pre-tag behavior.
 * - `when`: a map of dot-path → expected scalar, evaluated against the
 *   rendered Handlebars context with strict equality, all keys AND-ed. One
 *   deliberate exception: an expected `false` also matches `undefined`, so
 *   an option left unset behaves as switched off. Equality only — no
 *   expressions — to keep selection trivially deterministic.
 */
export interface DescriptorTarget {
  output: string;
  template: string;
  mode: 'create' | 'skip-if-exists' | 'overwrite';
  artifact?: string;
  when?: Record<string, string | number | boolean>;
}

export interface CommentSyntaxOverride {
  start: string;
  end: string;
}

/** Pack-level comment-syntax entry for one extension. */
export type PackCommentSyntaxEntry =
  | { prefix: string }
  | { wrap: [string, string] };

/** Record of file extension (including its leading dot, lower-cased) to the syntax used for injection markers in files of that extension. */
export type PackCommentSyntaxMap = Record<string, PackCommentSyntaxEntry>;

/**
 * Declares the intent-manifest fields a pack actually requires. `type`
 * constrains the JSON-Schema-validated shape; `pattern`/`minItems` add
 * extra checks. Missing `inputs` ⇒ the legacy `entity`+`fields` contract
 * is enforced by `manifest/inputValidation.ts`.
 */
export interface PackInputDeclaration {
  name: string;
  type: 'string' | 'integer' | 'boolean' | 'array' | 'object';
  required?: boolean;
  pattern?: string;
  minItems?: number;
}

/** Raw bootstrap-anchor shape as authored in the pack descriptor (string patterns, not yet compiled to RegExp). */
export type RawBootstrapAnchorKind =
  | { kind: 'after-line'; pattern: string }
  | { kind: 'after-class-brace'; declarationPattern: string };

export interface RawBootstrapAnchor {
  candidateFilenames: string[];
  anchor: RawBootstrapAnchorKind;
  markers: string[];
}

export interface DescriptorInjection {
  file: string;
  marker: string;
  template: string;
  position: 'before-end' | 'after-start';
  hashTrailerPrefix: string;
  /**
   * Appended after the hash hex on the trailer line — needed for wrap-style
   * comment syntaxes where the line must close (e.g. `<!-- scaffold-hash:`
   * needs ` -->`). Omitted for line-comment syntaxes.
   */
  hashTrailerSuffix?: string;
  /**
   * replace (default): the marker block holds exactly one render; re-running
   * with different content refuses without --force. append: per-entity
   * accumulation — each distinct rendered snippet is added to the block once,
   * an already-present snippet is an idempotent no-op, and the hash trailer
   * covers the accumulated block content.
   */
  strategy?: 'replace' | 'append';
  commentSyntax?: CommentSyntaxOverride;
  /** See DescriptorTarget — same artifact-tag semantics. */
  artifact?: string;
  /** See DescriptorTarget — same conditional-inclusion semantics. */
  when?: Record<string, string | number | boolean>;
}

export interface TemplateDescriptor {
  descriptorSchemaVersion: 2;
  packVersion: string;
  requires: { scaffoldCli: string };
  /**
   * The pack's default path fragments for `{{pathConfig.*}}` in target/
   * injection templates. Lowest precedence: a pack slot's persisted
   * `pathConfig` (brownfield adoption) and a manifest-level `pathConfig`
   * both override it. Lets `scaffold add` work without every manifest
   * repeating the pack's own layout.
   */
  pathConfig?: Record<string, string>;
  targets: DescriptorTarget[];
  injections: DescriptorInjection[];
  /** Pack-declared input vocabulary, enforced per-pack by manifest/inputValidation.ts. */
  inputs?: PackInputDeclaration[];
  /** Pack-level comment-syntax map, consulted by generate/commentSyntax.ts before the built-in TABLE. */
  commentSyntax?: PackCommentSyntaxMap;
  /** Pack-declared brownfield anchors, consumed by bootstrap-markers; falls back to the built-in ANCHOR_CATALOG if absent. */
  bootstrapAnchors?: RawBootstrapAnchor[];
}

const artifactTagSchema = { type: 'string', minLength: 1, pattern: '^[a-z0-9][a-z0-9-]*$' } as const;

// oneOf over three scalar schemas rather than a `type` array — ajv strict
// mode warns on union type keywords without allowUnionTypes, and the load
// path deliberately keeps default strict settings.
const whenSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
} as const;

const targetSchema = {
  type: 'object',
  additionalProperties: false,
  patternProperties: docFieldPattern,
  required: ['output', 'template', 'mode'],
  properties: {
    output: { type: 'string', minLength: 1 },
    template: { type: 'string', minLength: 1 },
    mode: { enum: ['create', 'skip-if-exists', 'overwrite'] },
    artifact: artifactTagSchema,
    when: whenSchema,
  },
} as const;

const commentSyntaxSchema = {
  type: 'object',
  additionalProperties: false,
  patternProperties: docFieldPattern,
  required: ['start', 'end'],
  properties: {
    start: { type: 'string', minLength: 1 },
    end: { type: 'string', minLength: 1 },
  },
} as const;

const injectionSchema = {
  type: 'object',
  additionalProperties: false,
  patternProperties: docFieldPattern,
  required: ['file', 'marker', 'template', 'position', 'hashTrailerPrefix'],
  properties: {
    file: { type: 'string', minLength: 1 },
    marker: { type: 'string', minLength: 1, not: { pattern: '^AI_IMPLEMENTATION' } },
    template: { type: 'string', minLength: 1 },
    position: { enum: ['before-end', 'after-start'] },
    hashTrailerPrefix: { type: 'string', minLength: 1 },
    hashTrailerSuffix: { type: 'string', minLength: 1 },
    strategy: { enum: ['replace', 'append'] },
    commentSyntax: commentSyntaxSchema,
    artifact: artifactTagSchema,
    when: whenSchema,
  },
} as const;

const packInputDeclarationSchema = {
  type: 'object',
  additionalProperties: false,
  patternProperties: docFieldPattern,
  required: ['name', 'type'],
  properties: {
    name: { type: 'string', minLength: 1 },
    type: { enum: ['string', 'integer', 'boolean', 'array', 'object'] },
    required: { type: 'boolean' },
    pattern: { type: 'string', minLength: 1 },
    minItems: { type: 'integer', minimum: 0 },
  },
} as const;

const packCommentSyntaxEntrySchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      patternProperties: docFieldPattern,
      required: ['prefix'],
      properties: { prefix: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      patternProperties: docFieldPattern,
      required: ['wrap'],
      properties: {
        wrap: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: { type: 'string' },
        },
      },
    },
  ],
} as const;

const packCommentSyntaxMapSchema = {
  type: 'object',
  additionalProperties: packCommentSyntaxEntrySchema,
} as const;

const rawBootstrapAnchorKindSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      patternProperties: docFieldPattern,
      required: ['kind', 'pattern'],
      properties: {
        kind: { enum: ['after-line'] },
        pattern: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      patternProperties: docFieldPattern,
      required: ['kind', 'declarationPattern'],
      properties: {
        kind: { enum: ['after-class-brace'] },
        declarationPattern: { type: 'string', minLength: 1 },
      },
    },
  ],
} as const;

const rawBootstrapAnchorSchema = {
  type: 'object',
  additionalProperties: false,
  patternProperties: docFieldPattern,
  required: ['candidateFilenames', 'anchor', 'markers'],
  properties: {
    candidateFilenames: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    anchor: rawBootstrapAnchorKindSchema,
    markers: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1, not: { pattern: '^AI_IMPLEMENTATION' } },
    },
  },
} as const;

export const descriptorSchema = {
  $id: 'https://scaffold-toolkit.dev/schemas/manifest-templates-v2.json',
  type: 'object',
  additionalProperties: true,
  required: ['descriptorSchemaVersion', 'packVersion', 'requires', 'targets', 'injections'],
  properties: {
    descriptorSchemaVersion: { const: 2 },
    packVersion: { type: 'string', minLength: 1 },
    requires: {
      type: 'object',
      additionalProperties: false,
      required: ['scaffoldCli'],
      properties: {
        scaffoldCli: { type: 'string', minLength: 1 },
      },
    },
    pathConfig: { type: 'object', additionalProperties: { type: 'string' } },
    targets: { type: 'array', items: targetSchema },
    injections: { type: 'array', items: injectionSchema },
    inputs: { type: 'array', items: packInputDeclarationSchema },
    commentSyntax: packCommentSyntaxMapSchema,
    bootstrapAnchors: { type: 'array', items: rawBootstrapAnchorSchema },
  },
} as const;
