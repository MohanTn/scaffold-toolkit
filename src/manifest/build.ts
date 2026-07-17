/**
 * Builds an intent manifest from a compact CLI spec (`scaffold manifest new`),
 * so the phase-1 artifact a host LLM must emit shrinks from a manifest file to
 * a single command line: `--field name:type` pairs and `--option path=value`
 * assignments expand deterministically into the same schema-validated manifest
 * `scaffold generate` consumes.
 */

import { validateManifest } from './decode.js';
import type { FieldSpec, IntentManifest } from './types.js';

export function parseFieldSpec(spec: string): FieldSpec {
  const idx = spec.indexOf(':');
  const name = idx > -1 ? spec.slice(0, idx).trim() : '';
  const type = idx > -1 ? spec.slice(idx + 1).trim() : '';
  if (!name || !type) {
    throw new Error(`invalid --field "${spec}" — expected name:type, e.g. Amount:decimal`);
  }
  return { name, type };
}

/**
 * `true`/`false` and plain numbers coerce so manifest options like
 * `retries=3` don't render as strings; everything else (including values
 * with leading zeros or whitespace) stays a verbatim string.
 */
function coerceValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw) && !/^-?0\d/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Dot-separated paths nest (`database.provider=sqlite` →
 * `{ database: { provider: "sqlite" } }`); a later assignment through a
 * non-object value is an authoring error, not a silent overwrite.
 */
export function assignOptionPath(target: Record<string, unknown>, assignment: string): void {
  const idx = assignment.indexOf('=');
  if (idx <= 0) {
    throw new Error(`invalid --option "${assignment}" — expected path=value, e.g. database.provider=sqlite`);
  }
  const segments = assignment.slice(0, idx).split('.');
  if (segments.some((s) => !s.trim())) {
    throw new Error(`invalid --option "${assignment}" — empty segment in option path`);
  }
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const key = segment.trim();
    const existing = cursor[key];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    } else if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      throw new Error(`invalid --option "${assignment}" — "${key}" is already set to a non-object value`);
    }
  }
  cursor[segments[segments.length - 1].trim()] = coerceValue(assignment.slice(idx + 1));
}

function parseInputAssignment(assignment: string): { name: string; value: unknown } {
  const idx = assignment.indexOf('=');
  if (idx <= 0) {
    throw new Error(`invalid --input "${assignment}" — expected name=value, e.g. name=MyModule`);
  }
  const name = assignment.slice(0, idx).trim();
  if (!name) {
    throw new Error(`invalid --input "${assignment}" — empty key before =`);
  }
  return { name, value: coerceValue(assignment.slice(idx + 1)) };
}

const RESERVED_MANIFEST_KEYS = new Set([
  'manifestSchemaVersion',
  'targetStack',
  'entity',
  'fields',
  'options',
  'artifacts',
]);

export interface BuildManifestInput {
  targetStack: string;
  entity?: string;
  fields: string[];
  options: string[];
  inputs: string[];
  artifacts?: string[];
}

export function buildIntentManifest(input: BuildManifestInput): IntentManifest {
  const manifest: Record<string, unknown> = {
    manifestSchemaVersion: 1,
    targetStack: input.targetStack,
  };
  if (input.entity !== undefined) manifest.entity = input.entity;
  if (input.artifacts !== undefined && input.artifacts.length > 0) manifest.artifacts = input.artifacts;
  if (input.fields.length > 0) manifest.fields = input.fields.map(parseFieldSpec);
  if (input.options.length > 0) {
    const options: Record<string, unknown> = {};
    for (const assignment of input.options) assignOptionPath(options, assignment);
    manifest.options = options;
  }
  if (input.inputs.length > 0) {
    for (const assignment of input.inputs) {
      const { name, value } = parseInputAssignment(assignment);
      if (RESERVED_MANIFEST_KEYS.has(name)) {
        throw new Error(`invalid --input "${assignment}" — "${name}" is a reserved manifest key`);
      }
      manifest[name] = value;
    }
  }
  return validateManifest(manifest);
}
