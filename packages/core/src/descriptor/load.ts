/**
 * Reads and validates a pack's manifest.templates.json against its ajv
 * schema, then range-checks `requires.scaffoldCli` against the installed
 * CLI's own version (shape is ajv's job, the semver range check is
 * separate) — failing fast before any file is touched.
 */

import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import semver from 'semver';
import { descriptorSchema } from './schema.js';
import type { TemplateDescriptor } from './schema.js';
import { readOwnPackageJson } from '../version/readPkg.js';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(descriptorSchema);

export class DescriptorValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`invalid manifest.templates.json:\n${errors.join('\n')}`);
  }
}

export class DescriptorRequiresMismatchError extends Error {}

export function validateDescriptor(data: unknown): TemplateDescriptor {
  if (!validate(data)) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
    throw new DescriptorValidationError(errors);
  }
  return data as TemplateDescriptor;
}

/**
 * `installedVersion` defaults to this installed CLI's own package.json
 * version (per the plan's readPkg.ts sharing), but callers may pass an
 * override — used by unit tests that need to exercise both sides of the
 * semver-range check without depending on whatever version this repo
 * happens to be pinned at.
 */
export function loadDescriptor(descriptorPath: string, installedVersion?: string): TemplateDescriptor {
  const raw = readFileSync(descriptorPath, 'utf8');
  const descriptor = validateDescriptor(JSON.parse(raw));

  const version = installedVersion ?? readOwnPackageJson(import.meta.url).version;
  if (!semver.satisfies(version, descriptor.requires.scaffoldCli, { includePrerelease: true })) {
    throw new DescriptorRequiresMismatchError(
      `pack "${descriptor.packVersion}" requires scaffoldCli ${descriptor.requires.scaffoldCli}, but the installed CLI is v${version}`,
    );
  }
  return descriptor;
}
