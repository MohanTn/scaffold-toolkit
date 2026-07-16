#!/usr/bin/env node
/**
 * packManifestReader: loads pack manifests and looks up coding standards
 * Used by pre-tool-use.mjs to inject file-type-specific guidelines before AI fills blocks
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Reads .scaffold/config.json and returns the configured packs
 * @param {string} cwd - working directory
 * @returns {{ packs: { [key: string]: { url: string, version?: string, pinnedSha: string } } } | null}
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
 * Resolves which configured pack owns a given file
 * Checks adoptedPaths and targets[] patterns from .scaffold/config.json
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

    // Normalize filePath for matching
    const normalized = path.normalize(filePath);

    // Check adoptedPaths first (brownfield files)
    if (config.adoptedPaths) {
      for (const [packName, paths] of Object.entries(config.adoptedPaths)) {
        if (paths && Array.isArray(paths)) {
          if (paths.some(p => normalized.includes(path.normalize(p)))) {
            const packInfo = config.packs[packName];
            if (packInfo) {
              return {
                packName,
                packVersion: packInfo.version || 'unknown',
                packPath: resolveCachePath(packInfo.pinnedSha, cwd),
              };
            }
          }
        }
      }
    }

    // As fallback: infer from path patterns (e.g., Repository.cs → likely from dotnet pack)
    // This is heuristic; adoptedPaths is authoritative
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves the actual disk path for a pack given its pinnedSha
 * Assumes standard scaffold cache layout: ~/.cache/scaffold/<sha>/
 * or .scaffold/packs/<sha>/
 * @param {string} pinnedSha - the pack's pinned git SHA
 * @param {string} cwd - working directory (for relative resolution)
 * @returns {string} absolute path to pack directory
 */
export function resolveCachePath(pinnedSha, cwd) {
  // First check local .scaffold/packs/ (in-repo cache)
  const localPath = path.join(cwd, '.scaffold', 'packs', pinnedSha);
  try {
    readFileSync(path.join(localPath, 'manifest.templates.json'));
    return localPath;
  } catch {
    // Fall back to user cache (if scaffold CLI manages global cache)
    // For now, return local path as best guess
    return localPath;
  }
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
