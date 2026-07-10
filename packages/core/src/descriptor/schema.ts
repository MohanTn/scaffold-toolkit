/**
 * ajv JSON Schema v2 for a template pack's manifest.templates.json.
 *
 * The root object allows unknown top-level fields (additionalProperties:
 * true) so a newer pack using a CLI-version field this engine doesn't yet
 * know about doesn't hard-fail; each targets[]/injections[] entry keeps
 * additionalProperties:false with its own required list, so typos in known
 * fields are still caught.
 *
 * `marker` rejects any value starting with "AI_IMPLEMENTATION", reserving
 * that namespace so a pack author can never accidentally collide a real
 * injection marker with the phase-3 fill-in region.
 */

export interface DescriptorTarget {
  output: string;
  template: string;
  mode: 'create' | 'skip-if-exists' | 'overwrite';
}

export interface CommentSyntaxOverride {
  start: string;
  end: string;
}

export interface DescriptorInjection {
  file: string;
  marker: string;
  template: string;
  position: 'before-end' | 'after-start';
  hashTrailerPrefix: string;
  commentSyntax?: CommentSyntaxOverride;
}

export interface TemplateDescriptor {
  descriptorSchemaVersion: 2;
  packVersion: string;
  requires: { scaffoldCli: string };
  targets: DescriptorTarget[];
  injections: DescriptorInjection[];
}

const targetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['output', 'template', 'mode'],
  properties: {
    output: { type: 'string', minLength: 1 },
    template: { type: 'string', minLength: 1 },
    mode: { enum: ['create', 'skip-if-exists', 'overwrite'] },
  },
} as const;

const commentSyntaxSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: {
    start: { type: 'string', minLength: 1 },
    end: { type: 'string', minLength: 1 },
  },
} as const;

const injectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'marker', 'template', 'position', 'hashTrailerPrefix'],
  properties: {
    file: { type: 'string', minLength: 1 },
    marker: { type: 'string', minLength: 1, not: { pattern: '^AI_IMPLEMENTATION' } },
    template: { type: 'string', minLength: 1 },
    position: { enum: ['before-end', 'after-start'] },
    hashTrailerPrefix: { type: 'string', minLength: 1 },
    commentSyntax: commentSyntaxSchema,
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
    targets: { type: 'array', items: targetSchema },
    injections: { type: 'array', items: injectionSchema },
  },
} as const;
