/**
 * Shared package.json reader. Mirrors pipeline_worker/src/cli.ts's own
 * ESM __dirname + readFileSync(package.json) pattern, generalized to work
 * from any depth under the package root: cli.ts's compiled entry sits at
 * dist/cli.js (package.json one directory up) while descriptor/load.ts sits
 * at dist/descriptor/load.js (two directories up) — and during `npm test`
 * both are also run directly from src/ via tsx, one directory shallower
 * again. Ascending until package.json is found covers all three cases
 * without every caller having to know or hardcode its own depth.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface PackageInfo {
  name: string;
  version: string;
}

const MAX_ASCEND = 6;

export function readOwnPackageJson(importMetaUrl: string): PackageInfo {
  let dir = path.dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < MAX_ASCEND; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf8')) as PackageInfo;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`readOwnPackageJson: could not locate package.json by ascending from ${path.dirname(fileURLToPath(importMetaUrl))}`);
}
