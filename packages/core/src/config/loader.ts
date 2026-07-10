/** Reads/writes .scaffold/config.json and resolves the target repo root. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import { configSchema } from './schema.js';
import type { ScaffoldConfig } from './schema.js';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(configSchema);

export class ConfigValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`invalid .scaffold/config.json:\n${errors.join('\n')}`);
  }
}

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, '.scaffold', 'config.json');
}

export function configExists(repoRoot: string): boolean {
  return existsSync(configPath(repoRoot));
}

export function loadConfig(repoRoot: string): ScaffoldConfig {
  const file = configPath(repoRoot);
  if (!existsSync(file)) {
    throw new Error(`no .scaffold/config.json found at ${file} — run "scaffold init" first`);
  }
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!validate(data)) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
    throw new ConfigValidationError(errors);
  }
  return data as ScaffoldConfig;
}

export function saveConfig(repoRoot: string, config: ScaffoldConfig): void {
  mkdirSync(path.join(repoRoot, '.scaffold'), { recursive: true });
  writeFileSync(configPath(repoRoot), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
