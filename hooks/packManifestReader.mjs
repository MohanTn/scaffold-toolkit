#!/usr/bin/env node
/**
 * packManifestReader: loads pack manifests and looks up coding standards
 * Used by pre-tool-use.mjs to inject file-type-specific guidelines before AI fills blocks
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SIBLING_CLI = path.join(HOOKS_DIR, '..', 'dist', 'cli.js');

/**
 * How the hooks should invoke the scaffold CLI: prefer the dist/cli.js
 * shipped alongside these hooks in the npm package (works without a global
 * install), fall back to `scaffold` on PATH.
 * @returns {{ command: string, prefixArgs: string[] }}
 */
export function resolveScaffoldInvocation() {
  if (existsSync(SIBLING_CLI)) {
    return { command: process.execPath, prefixArgs: [SIBLING_CLI] };
  }
  return { command: 'scaffold', prefixArgs: [] };
}

/**
 * Reads .scaffold/config.json and returns the configured packs
 * @param {string} cwd - working directory
 * @returns {{ [slot: string]: { path?: string, url?: string, version: string, pinnedSha?: string, adoptedPaths?: Record<string, string> } } | null}
 */
export function getConfiguredPacks(cwd) {
  try {
    const configPath = path.join(cwd, '.scaffold', 'config.json');
    const content = readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    return config.packs || {};
  } catch {
    return null;
  }
}

/**
 * Reads `.scaffold/conf.json`'s `editEnforcement` setting — per-repo control
 * over how pre-tool-use.mjs reacts to a `scaffold check-edit` denial:
 * "gate" (default): hard-block via `permissionDecision: "deny"`.
 * "nudge": surface the same reason as `additionalContext` and let the
 * write/edit proceed. Missing file, missing key, or an unrecognized value
 * all fall back to "gate" — must never silently weaken enforcement for a
 * repo that has no conf.json yet.
 * @param {string} cwd - working directory
 * @returns {'gate' | 'nudge'}
 */
export function getEnforcementMode(cwd) {
  try {
    const confPath = path.join(cwd, '.scaffold', 'conf.json');
    const conf = JSON.parse(readFileSync(confPath, 'utf8'));
    return conf.editEnforcement === 'nudge' ? 'nudge' : 'gate';
  } catch {
    return 'gate';
  }
}

/**
 * Resolves which configured pack owns a given file.
 * A pack slot's `adoptedPaths` (Record<templateKey, repoRelPath>, written by
 * `scaffold bootstrap-markers`) is authoritative for brownfield files; for
 * generated files the fallback is the first slot whose descriptor maps the
 * file to a template (see mapFileToTemplate).
 * @param {string} cwd - working directory
 * @param {string} filePath - absolute or relative file path
 * @returns {{ packName: string, packVersion: string, packPath: string } | null}
 */
export function resolvePack(cwd, filePath) {
  try {
    const configPath = path.join(cwd, '.scaffold', 'config.json');
    const content = readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);

    if (!config.packs) return null;

    const rel = path.normalize(
      path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath,
    );

    // adoptedPaths first (brownfield files): exact repo-relative match
    for (const [packName, pack] of Object.entries(config.packs)) {
      if (!pack || !pack.adoptedPaths) continue;
      const adopted = Object.values(pack.adoptedPaths).some(
        (p) => typeof p === 'string' && path.normalize(p) === rel,
      );
      if (adopted) {
        const packPath = resolvePackVersionDir(cwd, pack);
        if (packPath) {
          return { packName, packVersion: pack.version || 'unknown', packPath };
        }
      }
    }

    // Generated files: first slot whose descriptor has a matching target
    for (const [packName, pack] of Object.entries(config.packs)) {
      const packPath = resolvePackVersionDir(cwd, pack);
      if (!packPath) continue;
      const manifest = loadManifest(packPath);
      if (manifest && mapFileToTemplate(filePath, manifest)) {
        return { packName, packVersion: pack.version || 'unknown', packPath };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves the on-disk directory holding a pack version's
 * manifest.templates.json. A `path` pack is read straight off disk at
 * `<cwd>/<pack.path>/<pack.version>`; a `url` pack lives in the repo cache at
 * `.scaffold/cache/<sha256(url)>/<pinnedSha>/<pack.version>` — the url hash is
 * found by scanning the cache root rather than re-implementing the CLI's
 * normalization.
 * @param {string} cwd - working directory
 * @param {{ path?: string, url?: string, version?: string, pinnedSha?: string }} pack
 * @returns {string | null} absolute path to the version dir, or null
 */
export function resolvePackVersionDir(cwd, pack) {
  if (!pack || typeof pack.version !== 'string') return null;
  if (typeof pack.path === 'string') {
    const dir = path.resolve(cwd, pack.path, pack.version);
    return existsSync(path.join(dir, 'manifest.templates.json')) ? dir : null;
  }
  if (typeof pack.url === 'string' && typeof pack.pinnedSha === 'string') {
    const cacheRoot = path.join(cwd, '.scaffold', 'cache');
    let hashes;
    try {
      hashes = readdirSync(cacheRoot);
    } catch {
      return null;
    }
    for (const hash of hashes) {
      const dir = path.join(cacheRoot, hash, pack.pinnedSha, pack.version);
      if (existsSync(path.join(dir, 'manifest.templates.json'))) return dir;
    }
  }
  return null;
}

/**
 * Loads and parses manifest.templates.json from a pack directory
 * @param {string} packPath - absolute path to pack root
 * @returns {object | null} parsed manifest or null if not found/invalid
 */
export function loadManifest(packPath) {
  try {
    const manifestPath = path.join(packPath, 'manifest.templates.json');
    const content = readFileSync(manifestPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Maps an output file (e.g., OrderRepository.cs) to the template that generates it
 * Matches against manifest.targets[].output patterns
 * @param {string} filePath - absolute or relative output file path
 * @param {object} manifest - parsed manifest.templates.json
 * @returns {string | null} template filename (e.g., EntityRepository.cs.hbs) or null if no match
 */
export function mapFileToTemplate(filePath, manifest) {
  if (!manifest || !manifest.targets || !Array.isArray(manifest.targets)) {
    return null;
  }

  const fileName = path.basename(filePath);
  let bestMatch = null;
  let bestSpecificity = -1;

  for (const target of manifest.targets) {
    if (!target.output || !target.template) continue;

    // Convert handlebars pattern to regex: {{entity}}Repository.cs → /.*Repository\.cs/
    // Replace {{...}} first, then escape dots
    const patternStr = target.output
      .replace(/\{\{[^}]+\}\}/g, '__PLACEHOLDER__') // {{...}} → __PLACEHOLDER__
      .replace(/\./g, '\\.') // Escape dots
      .replace(/__PLACEHOLDER__/g, '.*'); // __PLACEHOLDER__ → .*

    const regex = new RegExp(`^${patternStr}$`);
    if (regex.test(fileName)) {
      // Prefer more specific matches (longer pattern text = more specific)
      const patternLength = target.output.length;

      if (bestMatch === null || patternLength > bestSpecificity) {
        bestMatch = target.template;
        bestSpecificity = patternLength;
      }
    }
  }

  return bestMatch;
}

/**
 * Looks up coding standards for a file in the manifest
 * Maps file to template, then looks up template in codingStandards
 * @param {string} filePath - output file path
 * @param {object} manifest - parsed manifest.templates.json
 * @returns {{ fileType: string, rules: string[] } | null}
 */
export function getStandardsForFile(filePath, manifest) {
  if (!manifest || !manifest.codingStandards) {
    return null;
  }

  const fileName = path.basename(filePath);

  // Try exact match first (file name)
  if (manifest.codingStandards[fileName]) {
    return manifest.codingStandards[fileName];
  }

  // Map file to template, then look up template
  const template = mapFileToTemplate(filePath, manifest);
  if (template && manifest.codingStandards[template]) {
    return manifest.codingStandards[template];
  }

  // Try pattern matching on codingStandards keys (wildcard patterns)
  let bestMatch = null;
  let bestPatternLength = -1;

  for (const [key, standards] of Object.entries(manifest.codingStandards)) {
    // Support wildcard patterns like Create*Handler or *Repository
    const pattern = key
      .replace(/\*/g, '__WILDCARD__') // * → __WILDCARD__
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
      .replace(/__WILDCARD__/g, '.*'); // __WILDCARD__ → .*
    const regex = new RegExp(`^${pattern}$`);

    if (regex.test(fileName)) {
      // Prefer longer/more specific patterns (fewer wildcards)
      const patternLength = key.length - (key.match(/\*/g) || []).length;
      if (patternLength > bestPatternLength) {
        bestMatch = standards;
        bestPatternLength = patternLength;
      }
    }
  }

  return bestMatch;
}

/**
 * Formats coding standards as a human-readable guidance string for context injection
 * @param {object} standards - { fileType, rules: [...] }
 * @param {string} filePath - file being edited (for context)
 * @param {{start: number, end: number} | null} blockLines - AI_IMPLEMENTATION block line range
 * @returns {string} formatted guidance for additionalContext
 */
export function formatStandardsGuidance(standards, filePath, blockLines = null) {
  const fileName = path.basename(filePath);
  const fileType = standards.fileType || 'file';
  const rules = Array.isArray(standards.rules) ? standards.rules : [];

  let guidance = `Coding standards for ${fileType} (${fileName}`;
  if (blockLines && blockLines.start && blockLines.end) {
    guidance += `, lines ${blockLines.start}-${blockLines.end}`;
  }
  guidance += '):\n';

  for (const rule of rules) {
    guidance += `- ${rule}\n`;
  }

  guidance += '\nThe class-level AI_IMPLEMENTATION marker allows you to add private helper methods as needed.';

  return guidance;
}
