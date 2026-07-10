/**
 * Shared TS types for the decoded intent manifest — the phase-1 artifact a host LLM writes.
 *
 * `entity` and `fields` are **optional** here because their presence/absence
 * is now managed per-pack, by `descriptor/schema.ts`'s `inputs` declaration
 * and `manifest/inputValidation.ts`'s enforcement — the base manifest
 * schema (`manifest/schema.ts`) no longer hard-requires them. Existing
 * dotnet packs' manifests still carry both, so existing call sites continue
 * to type-check; new packs without a single "entity" can omit either or
 * both and declare what they actually need in their descriptor.
 */

export interface FieldSpec {
  name: string;
  type: string;
  [extra: string]: unknown;
}

export interface IntentManifest {
  manifestSchemaVersion: number;
  targetStack: string;
  entity?: string;
  fields?: FieldSpec[];
  options?: Record<string, unknown>;
  [extra: string]: unknown;
}
