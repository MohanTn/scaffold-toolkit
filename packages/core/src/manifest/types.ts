/** Shared TS types for the decoded intent manifest — the phase-1 artifact a host LLM writes. */

export interface FieldSpec {
  name: string;
  type: string;
  [extra: string]: unknown;
}

export interface IntentManifest {
  manifestSchemaVersion: number;
  targetStack: string;
  entity: string;
  fields: FieldSpec[];
  options?: Record<string, unknown>;
  [extra: string]: unknown;
}
