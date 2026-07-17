/**
 * ajv JSON Schema for the intent manifest (the phase-1 artifact).
 *
 * **Base shape stays stack-agnostic.** `entity` (PascalCase) + `fields[]`
 * used to be in the runtime `required` list, which forced every pack —
 * even one whose architecture has no single "entity" (multiple aggregates,
 * feature modules, non-CRUD inputs) — to carry those exact two fields.
 * That constraint now lives per-pack, declared in the pack descriptor's
 * optional `inputs` (`descriptor/schema.ts`) and enforced by
 * `manifest/inputValidation.ts` *after* the pack is known. The base
 * schema here still keeps the *shape* checks for `entity`/`fields` so a
 * present-but-malformed value fails fast (a broken PascalCase name is a
 * real authoring bug, not a base-schema concern), but no longer
 * mandates their presence: `manifestSchemaVersion` + `targetStack` are
 * the only universally-required fields.
 *
 * Semantic field validation belongs to each pack's own templates, not a
 * stack-aware schema layer in the CLI, so `options` stays
 * `additionalProperties: true` and free-form, passed through as-is into
 * the Handlebars render context.
 */

export const intentManifestSchema = {
  $id: 'https://scaffold-toolkit.dev/schemas/intent-manifest.json',
  type: 'object',
  additionalProperties: true,
  required: ['manifestSchemaVersion', 'targetStack'],
  properties: {
    manifestSchemaVersion: { type: 'integer', const: 1 },
    targetStack: { type: 'string', minLength: 1 },
    entity: { type: 'string', pattern: '^[A-Z][A-Za-z0-9]*$' },
    fields: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name', 'type'],
        properties: {
          name: { type: 'string', minLength: 1 },
          type: { type: 'string', minLength: 1 },
        },
      },
    },
    options: { type: 'object', additionalProperties: true },
    artifacts: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
  },
} as const;
