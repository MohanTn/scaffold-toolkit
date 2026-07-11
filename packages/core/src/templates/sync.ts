/**
 * `scaffold templates sync [--update]`: clones or reuses the configured
 * template pack(s) into the local cache. Without `--update`, an already-
 * pinned pack is resolved straight to its pinned SHA (no network round
 * trip beyond what's needed to clone it if the cache is cold). With
 * `--update`, the ref is re-resolved to the remote's current HEAD SHA and
 * `.scaffold/config.json`'s pinned SHA is rewritten — the only supported
 * path to deliberately move a pinned pack forward.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config/loader.js';
import { isPathPack } from '../config/schema.js';
import type { PackConfig } from '../config/schema.js';
import { cloneToDir, resolveHeadSha } from './gitClone.js';
import { packCacheDir, LOCAL_PACK_RESOLVED_SHA } from './cache.js';

export function defaultCacheRoot(repoRoot: string): string {
  return path.join(repoRoot, '.scaffold', 'cache');
}

/**
 * Recursively finds every `helpers.js` inside `rootDir`. Pack-local helper
 * loaders (see `packHelpers.ts`) CommonJS-`require()` these files; see
 * `ensurePackCjsBaseline` below for the sibling function that ensures they
 * load under any parent package.json context.
 */
function findHelpersJsFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      // Skip the cloned pack's own `.git` directory — scanning it is wasteful
      // (loose objects tree) and never yields a helpers.js.
      if (name === '.git') continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && name === 'helpers.js') {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * For every `helpers.js` under `packRoot`, write a sibling `package.json`
 * with `{"type":"commonjs"}` UNLESS one already exists. The engine relies
 * on CommonJS `module.exports` for pack-local helpers (the documented
 * convention — see `packHelpers.ts`); Node walks upward from each
 * `helpers.js` looking for the nearest package.json to decide ESM-vs-CJS
 * scope, and scaffold-toolkit may be run from inside a workspace whose
 * own root `package.json` has `"type": "module"`. Without this baseline,
 * `require(helpersPath)` would throw `ERR_REQUIRE_ESM` ("module is not
 * defined in ES module scope") the first time a pack ships a `helpers.js`.
 * Leaving an existing pack-authored `package.json` untouched is intentional:
 * an author who explicitly opts into ESM helpers (e.g. via `.mjs`) keeps
 * their override.
 */
export function ensurePackCjsBaseline(packRoot: string): void {
  for (const helpersPath of findHelpersJsFiles(packRoot)) {
    const pkgJsonPath = path.join(path.dirname(helpersPath), 'package.json');
    if (existsSync(pkgJsonPath)) continue;
    writeFileSync(pkgJsonPath, '{"type":"commonjs"}\n', 'utf8');
  }
}

export interface SyncResult {
  pack: string;
  url: string;
  resolvedSha: string;
  changed: boolean;
}

async function ensureCloned(cacheRoot: string, url: string, resolvedSha: string): Promise<void> {
  const dir = packCacheDir(cacheRoot, url, resolvedSha);
  if (existsSync(dir)) return;

  mkdirSync(path.dirname(dir), { recursive: true });
  // git clone accepts an existing *empty* directory as its destination, so
  // the mkdtemp'd dir (guaranteed fresh and empty) is used as-is, then
  // renamed into place once the clone succeeds — a clone that fails partway
  // never leaves a half-populated entry at the final cache path.
  const tmp = mkdtempSync(path.join(tmpdir(), 'scaffold-clone-'));
  try {
    await cloneToDir(url, tmp);
    // Idempotent baseline for any pack-local helpers.js the pack ships:
    // write a sibling `{"type":"commonjs"}` `package.json` iff the pack
    // author didn't already ship one. See `ensurePackCjsBaseline` for the
    // full rationale — without this, the loader in `packHelpers.ts` fails
    // with `ERR_REQUIRE_ESM` whenever the cache lives inside a workspace
    // whose own root `package.json` has `type: "module"`.
    ensurePackCjsBaseline(tmp);
    try {
      renameSync(tmp, dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        cpSync(tmp, dir, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      } else {
        throw error;
      }
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

async function syncOnePack(cacheRoot: string, pack: PackConfig, update: boolean): Promise<SyncResult> {
  // A path-based pack is read straight off disk at generate/list time — no
  // clone, no cache entry, no pinned SHA to move. `changed: false` here means
  // syncTemplates's "rewrite pinnedSha if changed" logic below never touches
  // a path-based entry.
  if (isPathPack(pack)) {
    return { pack: '', url: pack.path, resolvedSha: LOCAL_PACK_RESOLVED_SHA, changed: false };
  }
  const resolvedSha = update || !pack.pinnedSha ? await resolveHeadSha(pack.url) : pack.pinnedSha;
  await ensureCloned(cacheRoot, pack.url, resolvedSha);
  return { pack: '', url: pack.url, resolvedSha, changed: resolvedSha !== pack.pinnedSha };
}

export async function syncTemplates(repoRoot: string, cacheRoot: string, options: { update?: boolean } = {}): Promise<SyncResult[]> {
  const config = loadConfig(repoRoot);
  const results: SyncResult[] = [];

  for (const [name, pack] of Object.entries(config.packs)) {
    const result = await syncOnePack(cacheRoot, pack, options.update ?? false);
    result.pack = name;
    // A path-based pack's syncOnePack always returns changed: false (see
    // above), so this branch is unreachable for it — the isPathPack guard
    // here is purely to satisfy the discriminated union's pinnedSha typing.
    if (result.changed && !isPathPack(pack)) {
      config.packs[name] = { ...pack, pinnedSha: result.resolvedSha };
    }
    results.push(result);
  }

  saveConfig(repoRoot, config);
  return results;
}
