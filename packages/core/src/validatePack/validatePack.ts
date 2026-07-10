/**
 * `scaffold validate-pack` — a pack-author / CI smoke test that runs a *real*
 * `scaffold generate` against a synthesized throwaway target repo, rather than
 * only compiling the Handlebars templates in isolation. This exercises the
 * parts render-only validation never touches: injection-path resolution, the
 * comment-syntax table, the marker scanner, per-marker hash trailers, the
 * AI_IMPLEMENTATION scan, and the descriptor schema + `requires` check.
 *
 * For every injection target that the pack's own `targets[]` do not create
 * (e.g. a host-provided `Program.cs`), it synthesizes that file with empty
 * marker pairs — exactly what `scaffold bootstrap-markers` would leave behind
 * — so the injector has somewhere to land, then asserts the generate run
 * completes and every declared injection actually lands.
 *
 * It clones the pack via the normal `templates sync` path, so it validates the
 * pack's committed git state (what CI checks out), not uncommitted working-tree
 * edits — the render-only `tools/validate-all.mjs` in each template repo stays
 * the fast working-tree iteration loop.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeManifestFile } from '../manifest/decode.js';
import { loadDescriptor } from '../descriptor/load.js';
import type { DescriptorInjection, PackCommentSyntaxMap } from '../descriptor/schema.js';
import { renderPathTemplate } from '../generate/render.js';
import { buildHandlebarsContext, runGenerate } from '../generate/generate.js';
import { resolveMarkerSyntax } from '../generate/commentSyntax.js';
import { syncTemplates, defaultCacheRoot } from '../templates/sync.js';
import { saveConfig } from '../config/loader.js';
import { validateManifestInputs } from '../manifest/inputValidation.js';

export interface PackValidationResult {
  version: string;
  ok: boolean;
  error?: string;
  targetsRendered: number;
  injectionsExercised: number;
  synthesizedFiles: string[];
}

/** Every immediate subdirectory of `packDir` that holds a `manifest.templates.json`. */
export function discoverPackVersions(packDir: string): string[] {
  return readdirSync(packDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(packDir, e.name, 'manifest.templates.json')))
    .map((e) => e.name)
    .sort();
}

/** Writes a synthetic host file containing an empty marker pair for each of `injections`, mirroring bootstrap-markers output. */
function synthesizeInjectionTarget(absPath: string, injections: DescriptorInjection[], packSyntaxMap?: PackCommentSyntaxMap): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const blocks = injections.map((inj) => {
    const syntax = resolveMarkerSyntax(absPath, inj.marker, inj.commentSyntax, packSyntaxMap);
    return `${syntax.startLine}\n${syntax.endLine}`;
  });
  writeFileSync(absPath, `${blocks.join('\n\n')}\n`, 'utf8');
}

export async function validatePackVersion(packDir: string, version: string, manifestPath: string): Promise<PackValidationResult> {
  const targetRepo = mkdtempSync(path.join(tmpdir(), 'scaffold-validate-'));
  const synthesizedFiles: string[] = [];
  try {
    const manifest = decodeManifestFile(manifestPath);
    const stack = manifest.targetStack;

    saveConfig(targetRepo, { projectType: 'validate-pack', packs: { [stack]: { url: packDir, version } } });
    const cacheRoot = defaultCacheRoot(targetRepo);
    await syncTemplates(targetRepo, cacheRoot);

    const descriptor = loadDescriptor(path.join(packDir, version, 'manifest.templates.json'));
    // Enforce the pack-declared (or legacy default) input contract explicitly,
    // before `runGenerate`'s identical internal check, so the failure
    // surfaces at this layer with `descriptor.packVersion` already in
    // scope (validate-pack's own catch in `validatePackVersion` then
    // returns the same ok:false result as any other failure).
    // `runGenerate`'s own call becomes a noop when the manifest already
    // passed this check — defensible duplication, not divergent logic.
    validateManifestInputs(descriptor.packVersion, manifest, descriptor.inputs);
    const context = buildHandlebarsContext(manifest as unknown as { entity?: string; fields?: unknown; options?: Record<string, unknown> });

    // Files the pack creates itself (rendered paths) never need synthesizing —
    // their template ships the marker pairs. Everything else an injection
    // targets is a host-provided file we stand in for.
    const createdPaths = new Set(descriptor.targets.map((t) => renderPathTemplate(t.output, context)));
    const injectionsByFile = new Map<string, DescriptorInjection[]>();
    for (const injection of descriptor.injections) {
      const fileRel = renderPathTemplate(injection.file, context);
      if (createdPaths.has(fileRel)) continue;
      const list = injectionsByFile.get(fileRel) ?? [];
      list.push(injection);
      injectionsByFile.set(fileRel, list);
    }
    for (const [fileRel, injections] of injectionsByFile) {
      // Pass the descriptor's pack-level commentSyntax map through to the
      // synthesizer, so a pack targeting a non-built-in extension (e.g. a
      // Python pack writing into `.py`) gets the same syntax resolution
      // path as in `runGenerate` — synthesized host files use the pack's
      // declared syntax, not just the built-in TABLE.
      synthesizeInjectionTarget(path.join(targetRepo, fileRel), injections, descriptor.commentSyntax);
      synthesizedFiles.push(fileRel);
    }

    const report = await runGenerate({ repoRoot: targetRepo, manifestPath, dryRun: false, force: false });

    return {
      version,
      ok: true,
      targetsRendered: report.created.length,
      injectionsExercised: report.injected.length,
      synthesizedFiles,
    };
  } catch (error) {
    return { version, ok: false, error: error instanceof Error ? error.message : String(error), targetsRendered: 0, injectionsExercised: 0, synthesizedFiles };
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
  }
}

export interface ValidatePackOptions {
  packDir: string;
  version?: string;
  manifestPath: string;
}

/** Validates one version (if given) or every discovered version of the pack. */
export async function validatePack(options: ValidatePackOptions): Promise<PackValidationResult[]> {
  const versions = options.version ? [options.version] : discoverPackVersions(options.packDir);
  if (versions.length === 0) {
    throw new Error(`no pack versions (folders containing manifest.templates.json) found under ${options.packDir}`);
  }
  const results: PackValidationResult[] = [];
  for (const version of versions) {
    results.push(await validatePackVersion(options.packDir, version, options.manifestPath));
  }
  return results;
}
