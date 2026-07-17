/**
 * `scaffold add feature` — compiles the spec-style entity-first flags into
 * an intent manifest scoped to the base per-entity artifacts plus the chosen
 * CRUD operations. Pure: flags in, manifest out; `runGenerate` does the rest.
 */

import type { IntentManifest } from '../manifest/types.js';
import { validateManifest } from '../manifest/decode.js';
import { parsePropertyList } from './common.js';

export interface AddFeatureFlags {
  name: string;
  properties: string;
  targetStack: string;
  db?: string;
  operations?: string;
  controller?: string;
  namespace?: string;
  target?: string;
  combine?: boolean;
}

const OPERATION_TAGS: Record<string, string> = {
  create: 'op-create',
  read: 'op-read',
  update: 'op-update',
  delete: 'op-delete',
};

/** "Create,Read" (case-insensitive) → ['op-create','op-read']; default all four, in the fixed create/read/update/delete order regardless of input order. */
export function parseOperations(spec: string | undefined): { tags: string[]; ops: Record<string, boolean> } {
  const requested = new Set(
    (spec ?? 'Create,Read,Update,Delete')
      .split(',')
      .map((op) => op.trim().toLowerCase())
      .filter((op) => op.length > 0),
  );
  const unknown = [...requested].filter((op) => !(op in OPERATION_TAGS));
  if (unknown.length > 0) {
    throw new Error(`invalid --operations value(s): ${unknown.join(', ')} — expected any of Create,Read,Update,Delete`);
  }
  if (requested.size === 0) {
    throw new Error('invalid --operations — expected at least one of Create,Read,Update,Delete');
  }
  const ops: Record<string, boolean> = {};
  const tags: string[] = [];
  for (const [op, tag] of Object.entries(OPERATION_TAGS)) {
    ops[op] = requested.has(op);
    if (requested.has(op)) tags.push(tag);
  }
  return { tags, ops };
}

export function compileAddFeature(flags: AddFeatureFlags): IntentManifest {
  const { tags, ops } = parseOperations(flags.operations);

  const options: Record<string, unknown> = { ops };
  if (flags.db !== undefined) options.database = { scope: flags.db };
  if (flags.combine === true) options.combine = true;
  if (flags.controller !== undefined) options.controllerName = flags.controller;
  if (flags.target !== undefined) options.targetFolder = flags.target;

  const manifest: IntentManifest = {
    manifestSchemaVersion: 1,
    targetStack: flags.targetStack,
    entity: flags.name,
    fields: parsePropertyList(flags.properties, '--properties'),
    options,
    artifacts: ['base', ...tags],
  };
  if (flags.namespace !== undefined) manifest.companyProjectName = flags.namespace;
  return validateManifest(manifest);
}
