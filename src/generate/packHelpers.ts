/**
 * Loads a template pack's optional pack-local `helpers.js` and registers its
 * Handlebars helpers before that pack's templates are rendered. Packs may
 * ship a `helpers.js` next to their `manifest.templates.json` exporting
 * `{ register(handlebars) { ... } }` (CommonJS, per each pack's own
 * documented convention) — this is the loader that convention assumed
 * existed but that the engine never actually implemented.
 *
 * Pack templates already render with `noEscape: true` (render.ts) on the
 * understanding that a pack is trusted content, so this is a plain
 * `require`, no sandboxing beyond what the pack author already gets from
 * writing a template.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';

const requireFromHere = createRequire(import.meta.url);

interface PackHelpersModule {
  register?: (handlebars: typeof Handlebars) => void;
}

/**
 * No-ops when the pack ships no `helpers.js` (most packs won't need one).
 * The require cache is bypassed so a `templates sync --update` that pulls
 * new pack content within the same process picks up the new helpers.js
 * rather than a stale cached module.
 */
export function registerPackHelpers(versionDir: string): void {
  const helpersPath = path.join(versionDir, 'helpers.js');
  if (!existsSync(helpersPath)) return;

  const resolved = requireFromHere.resolve(helpersPath);
  delete requireFromHere.cache[resolved];
  const mod = requireFromHere(helpersPath) as PackHelpersModule;

  if (typeof mod.register !== 'function') {
    throw new Error(`pack helpers at ${helpersPath} must export a "register(handlebars)" function`);
  }
  mod.register(Handlebars);
}
