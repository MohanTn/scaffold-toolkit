/**
 * Reads this package's own package.json, per the project's standing convention
 * (mirrors `pipeline_worker`'s ESM __dirname pattern + readPkg helper).
 *
 *   - `fileURLToPath(import.meta.url)` gives the URL this file was loaded
 *     from, equivalent to `__filename`.
 *   - `path.dirname(...)` is the ESM `__dirname`.
 *   - The package.json lives one directory up from `src/`, so we resolve
 *     `..` after the dirname.
 *
 * The result is cached so `gh-scaffold --version` doesn't re-parse on every
 * invocation, and so the result stays a single stable object.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let cached = null;

export function readOwnPackageJson() {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '..', 'package.json');
  cached = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return cached;
}
