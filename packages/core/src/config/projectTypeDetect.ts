/**
 * `scaffold init`'s project-type heuristics. Only consulted when
 * `--project-type` is omitted; returns undefined on ambiguity so the caller
 * (cli.ts) can fall back to a single interactive stdin prompt — the one
 * interactive path in this CLI, since `generate`/`undo` run unattended.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const JS_FRAMEWORK_DEPS = ['react', 'next', 'vue', 'express', '@angular/core'];

function hasFileMatching(dir: string, pattern: RegExp): boolean {
  return readdirSync(dir).some((entry) => pattern.test(entry));
}

function readPackageJsonDeps(repoRoot: string): Record<string, string> {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return {};
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

export function detectProjectType(repoRoot: string): string | undefined {
  if (hasFileMatching(repoRoot, /\.(csproj|sln)$/i)) return 'dotnet';

  const deps = readPackageJsonDeps(repoRoot);
  if (JS_FRAMEWORK_DEPS.some((dep) => dep in deps)) return 'js-family';

  if (existsSync(path.join(repoRoot, 'go.mod'))) return 'go';
  if (existsSync(path.join(repoRoot, 'pyproject.toml')) || existsSync(path.join(repoRoot, 'requirements.txt'))) return 'python';

  return undefined;
}
