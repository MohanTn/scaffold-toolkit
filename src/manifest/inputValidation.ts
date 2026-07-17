/**
 * Per-pack intent-manifest input validation.
 *
 * The base intent-manifest schema (`manifest/schema.ts`) now only requires
 * `manifestSchemaVersion` + `targetStack` — the `entity`/`fields[]` input
 * vocabulary was hardcoded as the universal contract, so any pack whose
 * architecture has no single "entity" (multiple aggregates, a feature
 * module, non-CRUD inputs) couldn't drive `generate`. Per-pack input
 * contracts are declared in `descriptor/schema.ts`'s optional `inputs[]`
 * entry and enforced **after** the pack descriptor is loaded, here.
 *
 * Validation contract:
 *
 * - If `descriptor.inputs` is declared, compile it into an ajv object
 *   schema fragment (with `required` drawn from each entry's `required`
 *   flag and `properties` from name/type/pattern/minItems) and validate
 *   the manifest's top-level object against it.
 * - If `descriptor.inputs` is absent, fall back to the **legacy default**
 *   contract: PascalCase `entity` + non-empty `fields[]` — preserves
 *   today's guarantees for every existing dotnet pack unchanged.
 *
 * Every failure names the pack (by `descriptor.packVersion`) and the
 * specific field that failed, so a pack author or CI sees the exact
 * constraint that was violated, not just a generic "manifest invalid".
 *
 * Base-schema-level checks (e.g. `manifestSchemaVersion === 1`,
 * `targetStack` non-empty) still happen upstream in
 * `manifest/decode.ts`'s `validateManifest` — this module only enforces
 * the pack-declared or legacy input contract, not the base shape.
 */

import { Ajv } from 'ajv';
import type { PackInputDeclaration } from '../descriptor/schema.js';

export class ManifestInputValidationError extends Error {
  constructor(
    public readonly packVersion: string,
    public readonly errors: string[],
  ) {
    super(
      `intent manifest failed pack "${packVersion}" input contract:\n${errors.join('\n')}`,
    );
  }
}

/** The legacy default contract: PascalCase `entity` + non-empty `fields[]` (item name + type required). */
function legacyInputsSchemaFragment(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['entity', 'fields'],
    properties: {
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
    },
  };
}

/** Compiles a per-pack `inputs[]` declaration into an ajv object-schema fragment. */
function packInputsSchemaFragment(inputs: PackInputDeclaration[]): Record<string, unknown> {
  // `Object.defineProperty` (used below) always creates an OWN property
  // regardless of key name, so a hostile pack declaring
  // `name: "__proto__"` (or any other prototype-namespaced key) cannot
  // reach Object.prototype through this code. We still construct the
  // `properties` map via `Object.create(null)` as belt-and-suspenders:
  // any future switch to bracket-assignment would still be safe, and
  // ajv's internal iteration over `properties` cannot accidentally walk
  // a polluted prototype chain. The `required` array uses ordinary
  // `Array#push`, which appends a value (not mutates prototype) regardless
  // of the value pushed.
  const required: string[] = [];
  const properties: Record<string, unknown> = Object.create(null);

  for (const decl of inputs) {
    if (decl.required !== false) required.push(decl.name);

    const prop: Record<string, unknown> = { type: decl.type };
    if (decl.pattern !== undefined) prop.pattern = decl.pattern;
    if (decl.type === 'array' && decl.minItems !== undefined) prop.minItems = decl.minItems;

    Object.defineProperty(properties, decl.name, { value: prop, enumerable: true, configurable: true, writable: true });
  }

  return {
    type: 'object',
    additionalProperties: true,
    required,
    properties,
  };
}

/**
 * Validates `manifest`'s top-level fields against either `descriptor.inputs`
 * (if declared) or the legacy default contract. Throws
 * `ManifestInputValidationError` naming the pack on any failure.
 */
export function validateManifestInputs(
  packVersion: string,
  manifest: unknown,
  inputs?: PackInputDeclaration[],
): void {
  const fragment =
    inputs === undefined ? legacyInputsSchemaFragment() : packInputsSchemaFragment(inputs);

  // A dedicated Ajv instance for each call: the fragment is tiny and
  // throwaway, and a fresh instance avoids any cross-call state when this
  // module runs once per `generate` invocation.
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(fragment);

  if (!validate(manifest)) {
    const errors = (validate.errors ?? []).map((e) => {
      const path = e.instancePath || '/';
      return `${path} ${e.message ?? 'invalid'}${e.params ? ` (${formatParams(e.params)})` : ''}`;
    });
    throw new ManifestInputValidationError(packVersion, errors);
  }
}

function formatParams(params: Record<string, unknown>): string {
  // ajv's structured params are usually a `{errorName, ...}` shape; flatten
  // the most useful keys for human readability, skipping any unknowns.
  const known = ['error', 'pattern', 'missingProperty', 'limit', 'type'];
  return known
    .filter((k) => params[k] !== undefined)
    .map((k) => `${k}=${JSON.stringify(params[k])}`)
    .join(' ');
}
