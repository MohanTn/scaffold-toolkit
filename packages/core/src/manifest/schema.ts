/**
 * ajv JSON Schema for the intent manifest (the phase-1 artifact). Deliberately
 * minimal and stack-agnostic: `options` stays additionalProperties:true and
 * free-form, passed through as-is into the Handlebars render context, since
 * semantic field validation belongs to each pack's own templates, not a
 * stack-aware schema layer in the CLI.
 */

export const intentManifestSchema = {
  $id: 'https://scaffold-toolkit.dev/schemas/intent-manifest.json',
  type: 'object',
  additionalProperties: true,
  required: ['manifestSchemaVersion', 'targetStack', 'entity', 'fields'],
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
  },
} as const;
