/**
 * Decodes an intent manifest file, auto-detecting TOON vs plain JSON by
 * extension (`.json` for non-LLM tooling/CI fixtures, anything else — by
 * convention `.toon` — via @toon-format/toon), then validates it against
 * the intent manifest's JSON Schema regardless of wire format.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import { decodeToon } from '../toon/codec.js';
import { intentManifestSchema } from './schema.js';
import type { IntentManifest } from './types.js';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(intentManifestSchema);

export class ManifestValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`intent manifest failed schema validation:\n${errors.join('\n')}`);
  }
}

export function validateManifest(data: unknown): IntentManifest {
  if (!validate(data)) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
    throw new ManifestValidationError(errors);
  }
  return data as IntentManifest;
}

export function decodeManifestFile(filePath: string): IntentManifest {
  const raw = readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const data: unknown = ext === '.json' ? JSON.parse(raw) : decodeToon(raw);
  return validateManifest(data);
}
