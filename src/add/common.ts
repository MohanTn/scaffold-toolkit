/**
 * Shared pieces of the `scaffold add` compiler layer: pack-slot resolution
 * and the comma-separated "Name:type,Other:type" list syntax the spec-style
 * flags use. Every function here is pure — the only I/O in the add flow is
 * `runGenerate` itself.
 */

import type { ScaffoldConfig } from '../config/schema.js';
import type { FieldSpec } from '../manifest/types.js';
import { parseFieldSpec } from '../manifest/build.js';

/**
 * `--template-set` names the pack slot in `.scaffold/config.json` directly
 * (the slot's `version` folder is what actually varies the template set).
 * Without it, a repo with exactly one configured slot uses that; more than
 * one is ambiguous and errors with the available names.
 */
export function resolveSlot(config: ScaffoldConfig, templateSet?: string): string {
  const slots = Object.keys(config.packs);
  if (templateSet !== undefined) {
    if (!config.packs[templateSet]) {
      throw new Error(`no pack slot "${templateSet}" in .scaffold/config.json — configured slots: ${slots.join(', ') || '(none)'}`);
    }
    return templateSet;
  }
  if (slots.length === 1) return slots[0];
  if (slots.length === 0) {
    throw new Error('no packs configured — run "scaffold init" first');
  }
  throw new Error(`multiple pack slots configured (${slots.join(', ')}) — pick one with --template-set <slot>`);
}

/**
 * Splits "Name:string,Price:decimal,Tags:List<string>" into FieldSpecs.
 * Commas inside angle brackets don't split, so `Dictionary<string,int>`
 * stays one type. Each piece reuses `parseFieldSpec`'s name:type contract.
 */
export function parsePropertyList(spec: string, flagName: string): FieldSpec[] {
  const pieces: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of spec) {
    if (ch === '<') depth += 1;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      pieces.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  pieces.push(current);

  const fields = pieces.map((p) => p.trim()).filter((p) => p.length > 0);
  if (fields.length === 0) {
    throw new Error(`${flagName} is empty — expected a comma-separated list like "Name:string,Price:decimal"`);
  }
  try {
    return fields.map(parseFieldSpec);
  } catch (error) {
    throw new Error(`invalid ${flagName}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Options shared by every `scaffold add` subcommand's CLI action. */
export interface AddRunFlags {
  dryRun: boolean;
  force: boolean;
  json: boolean;
  format?: string;
  templateSet?: string;
}
