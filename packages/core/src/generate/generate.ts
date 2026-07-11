/**
 * Orchestrates `scaffold generate`: a single code path for both the real
 * run and `--dry-run`. Every step through rendering and injection-point
 * diffing runs identically regardless of the flag; only the final disk-write,
 * change-manifest, pending-tracker, and config-save steps are gated on
 * `!dryRun`. This is what guarantees dry-run output matches the real run,
 * provided the working tree is unchanged in between.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config/loader.js';
import { isPathPack } from '../config/schema.js';
import { decodeManifestFile } from '../manifest/decode.js';
import { loadDescriptor } from '../descriptor/load.js';
import type { DescriptorTarget } from '../descriptor/schema.js';
import { validateManifestInputs } from '../manifest/inputValidation.js';
import { packCacheDir, LOCAL_PACK_RESOLVED_SHA } from '../templates/cache.js';
import { defaultCacheRoot } from '../templates/sync.js';
import { renderPathTemplate, renderTemplateFile } from './render.js';
import { registerPackHelpers } from './packHelpers.js';
import { resolveInsideRepo } from './pathGuard.js';
import { injectMarkers } from './injector.js';
import type { InjectionRequest } from './injector.js';
import { checkProvenance, recordProvenance } from './provenance.js';
import { scanAiImplementationBlocks } from './markerScan.js';
import { writeChangeManifest, nextChangesetId, sha256Hex } from './changeManifest.js';
import type { ChangeEntry } from './changeManifest.js';
import { writePending } from './pendingTracker.js';
import type { GenerateReport, ReportAiImplementationEntry, ReportCreatedEntry, ReportInjectedEntry } from './report.js';
import { checkCreationGate } from './creationGate.js';
import type { CreationGateTarget } from './creationGate.js';

export interface GenerateOptions {
  repoRoot: string;
  manifestPath: string;
  dryRun: boolean;
  force: boolean;
  cacheRoot?: string;
}

interface PlannedCreate {
  absPath: string;
  relPath: string;
  mode: DescriptorTarget['mode'];
  skip: boolean;
  existedBefore: boolean;
  priorContent: string | null;
  content: string;
}

interface PlannedInjectionGroup {
  absPath: string;
  relPath: string;
  requests: InjectionRequest[];
}

export function buildHandlebarsContext(manifest: { entity?: string; fields?: unknown; options?: Record<string, unknown> } & Record<string, unknown>): Record<string, unknown> {
  const options = manifest.options ?? {};
  // The manifest's top-level fields are spread last so they always win over
  // any same-named key inside the free-form, schema-unvalidated `options`
  // object (e.g. an `options.entity` that doesn't match the PascalCase
  // pattern the manifest schema enforces on the real `entity` field). The
  // whole manifest is passed through, not just entity/fields — packs like
  // scaffold-templates-react contract on host-precomputed top-level fields
  // (entityCamel, entityPlural, primaryKeyField, …). `options` itself is
  // still reachable in templates as `{{options.foo}}`, unshadowed.
  // `entity`/`fields` are now optional on the manifest (base schema no longer
  // requires them — each pack declares what it needs in `descriptor.inputs`,
  // enforced after the descriptor loads by `validateManifestInputs`). A
  // calling pack author who wants them required still gets them — this is
  // strictly a relaxation of the *base* type to match the *base* schema.
  return { ...options, ...manifest, options };
}

export async function runGenerate(options: GenerateOptions): Promise<GenerateReport> {
  const { repoRoot, dryRun, force } = options;
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(repoRoot);

  const manifest = decodeManifestFile(options.manifestPath);
  const config = loadConfig(repoRoot);

  const pack = config.packs[manifest.targetStack];
  if (!pack) {
    throw new Error(`no pack configured for targetStack "${manifest.targetStack}" — check .scaffold/config.json`);
  }

  // A path-based pack reads straight off disk: no cache, no pinned SHA, no
  // "run sync first" step. A url-based pack keeps the existing cache lookup,
  // gated on having been synced at least once.
  let versionDir: string;
  let packIdentity: { packUrl: string; resolvedSha: string };
  if (isPathPack(pack)) {
    const packDir = path.resolve(repoRoot, pack.path);
    versionDir = path.join(packDir, pack.version);
    packIdentity = { packUrl: pack.path, resolvedSha: LOCAL_PACK_RESOLVED_SHA };
  } else {
    if (!pack.pinnedSha) {
      throw new Error(`pack "${manifest.targetStack}" has not been synced yet — run "scaffold templates sync" first`);
    }
    const packDir = packCacheDir(cacheRoot, pack.url, pack.pinnedSha);
    versionDir = path.join(packDir, pack.version);
    packIdentity = { packUrl: pack.url, resolvedSha: pack.pinnedSha };
  }

  const descriptorPath = path.join(versionDir, 'manifest.templates.json');
  if (!existsSync(descriptorPath)) {
    throw new Error(
      isPathPack(pack)
        ? `template pack version "${pack.version}" not found at ${versionDir} — check the pack directory and version folder`
        : `template pack version "${pack.version}" not found in cache at ${versionDir} — run "scaffold templates sync" first`,
    );
  }

  // Validates the descriptor's own schema and range-checks requires.scaffoldCli
  // against the installed CLI version — fails fast, before any file is touched.
  const descriptor = loadDescriptor(descriptorPath);
  registerPackHelpers(versionDir);

  // Enforce the pack-declared (or legacy default) input contract now that we
  // know which pack is driving the manifest. The base `validateManifest` only
  // checks universal shape (manifestSchemaVersion + targetStack present) — the
  // pack's own `inputs[]` declaration (or the legacy entity+fields contract
  // for non-declaring packs) is enforced here, after the descriptor load.
  validateManifestInputs(descriptor.packVersion, manifest, descriptor.inputs);

  const context = buildHandlebarsContext(manifest);

  // --- Resolve and gate creation-mode targets -------------------------------------
  // Resolve all targets once before any rendering or gating. Store the resolved
  // paths so we can gate against the creation manifest before any side effects.
  interface ResolvedTarget {
    target: DescriptorTarget;
    absPath: string;
    relPath: string;
    existedBefore: boolean;
  }
  const resolvedTargets: ResolvedTarget[] = [];
  for (const target of descriptor.targets) {
    const outputRel = renderPathTemplate(target.output, context);
    const absPath = resolveInsideRepo(repoRoot, outputRel);
    const relPath = path.relative(repoRoot, absPath);
    const existedBefore = existsSync(absPath);
    resolvedTargets.push({ target, absPath, relPath, existedBefore });
  }

  // Gate: `overwrite`-mode targets must already exist on disk
  const creationGateTargets: CreationGateTarget[] = resolvedTargets.map((rt) => ({
    relPath: rt.relPath,
    mode: rt.target.mode,
    existedBefore: rt.existedBefore,
  }));
  checkCreationGate(creationGateTargets);

  // --- Plan create-mode targets --------------------------------------------------
  const plannedCreates: PlannedCreate[] = [];
  for (const resolved of resolvedTargets) {
    const absPath = resolved.absPath;
    const relPath = resolved.relPath;
    const target = resolved.target;
    const existedBefore = resolved.existedBefore;

    if (existedBefore && target.mode === 'create') {
      throw new Error(`${relPath} already exists and its target mode is "create" — use "skip-if-exists" or "overwrite" in the pack descriptor`);
    }

    const skip = existedBefore && target.mode === 'skip-if-exists';
    const priorContent = existedBefore ? readFileSync(absPath, 'utf8') : null;
    const content = skip ? (priorContent ?? '') : renderTemplateFile(path.join(versionDir, target.template), context);

    plannedCreates.push({ absPath, relPath, mode: target.mode, skip, existedBefore, priorContent, content });
  }

  // Files this run creates are visible to injections targeting the same
  // file within the same generate call, without requiring a disk round trip.
  const virtualContent = new Map<string, string>();
  // A target rendered fresh by *this* run (not previously on disk) may still
  // ship its marker interior pre-filled by the template author rather than
  // empty. That content was never a human's hand-edit, so it must not trip
  // the injector's "protect existing content" refusal the way genuine
  // pre-existing content would — the injector treats any path in this set
  // as safe to stamp outright, same as a truly empty marker.
  const freshlyCreatedPaths = new Set<string>();
  for (const created of plannedCreates) {
    if (!created.skip) {
      virtualContent.set(created.absPath, created.content);
      if (!created.existedBefore) freshlyCreatedPaths.add(created.absPath);
    }
  }

  function readOriginalContent(absPath: string): string {
    const virtual = virtualContent.get(absPath);
    if (virtual !== undefined) return virtual;
    return readFileSync(absPath, 'utf8');
  }

  // --- Plan injections, grouped by target file (single-pass rebuild per file) ----
  const groupsByFile = new Map<string, PlannedInjectionGroup>();
  for (const injection of descriptor.injections) {
    const fileRel = renderPathTemplate(injection.file, context);
    const absPath = resolveInsideRepo(repoRoot, fileRel);
    const relPath = path.relative(repoRoot, absPath);

    if (!existsSync(absPath) && !virtualContent.has(absPath)) {
      throw new Error(`injection target "${relPath}" does not exist in the target repo`);
    }

    const renderedContent = renderTemplateFile(path.join(versionDir, injection.template), context);
    const group = groupsByFile.get(absPath) ?? { absPath, relPath, requests: [] };
    group.requests.push({
      marker: injection.marker,
      renderedContent,
      hashTrailerPrefix: injection.hashTrailerPrefix,
      position: injection.position,
      strategy: injection.strategy ?? 'replace',
      commentSyntaxOverride: injection.commentSyntax,
      packSyntaxMap: descriptor.commentSyntax,
    });
    groupsByFile.set(absPath, group);
  }

  // Provenance check up front, for every targeted file, before any injector
  // call — a mismatch on any file aborts the whole run before anything is written.
  const provenanceRecord = { packUrl: packIdentity.packUrl, packVersion: pack.version, resolvedSha: packIdentity.resolvedSha };
  for (const group of groupsByFile.values()) {
    checkProvenance(config, group.relPath, provenanceRecord);
  }

  // --- Run the injector per file (throws InjectionRefusedError before any write) -
  interface InjectedFile {
    absPath: string;
    relPath: string;
    originalContent: string;
    newContent: string;
    outcomes: ReportInjectedEntry[];
    changed: boolean;
  }
  const injectedFiles: InjectedFile[] = [];
  for (const group of groupsByFile.values()) {
    const originalContent = readOriginalContent(group.absPath);
    const { content: newContent, outcomes } = injectMarkers(group.relPath, originalContent, group.requests, force, freshlyCreatedPaths.has(group.absPath));
    injectedFiles.push({
      absPath: group.absPath,
      relPath: group.relPath,
      originalContent,
      newContent,
      outcomes: outcomes.map((o) => ({ file: group.relPath, marker: o.marker, action: o.action })),
      changed: newContent !== originalContent,
    });
  }

  // --- AI_IMPLEMENTATION scan, over files this run actually created/modified -----
  // blockIndex is the block's ordinal among all blocks in its file, kept so
  // the pending record survives line drift as earlier blocks get filled.
  interface ScannedAiBlock extends ReportAiImplementationEntry {
    blockIndex: number;
  }
  const aiBlocks: ScannedAiBlock[] = [];
  function collectAiBlocks(relPath: string, content: string): void {
    for (const [blockIndex, block] of scanAiImplementationBlocks(relPath, content).entries()) {
      aiBlocks.push({
        file: relPath,
        blockIndex,
        startLine: block.startLine,
        endLine: block.endLine,
        content: block.content,
        empty: block.empty,
        required: block.required,
      });
    }
  }
  for (const created of plannedCreates) {
    if (created.skip) continue;
    collectAiBlocks(created.relPath, created.content);
  }
  for (const injected of injectedFiles) {
    if (!injected.changed) continue;
    collectAiBlocks(injected.relPath, injected.newContent);
  }
  const aiImplementation: ReportAiImplementationEntry[] = aiBlocks.map(
    ({ file, startLine, endLine, content, empty, required }) => ({ file, startLine, endLine, content, empty, required }),
  );

  const created: ReportCreatedEntry[] = plannedCreates.map((c) => ({ file: c.relPath, mode: c.mode, skipped: c.skip }));
  const injected: ReportInjectedEntry[] = injectedFiles.flatMap((f) => f.outcomes);

  const report: GenerateReport = { dryRun, created, injected, aiImplementation };

  if (dryRun) return report;

  // --- Write phase: only reached for a real run --------------------------------
  const changeEntries: ChangeEntry[] = [];

  for (const c of plannedCreates) {
    if (c.skip) continue;
    mkdirSync(path.dirname(c.absPath), { recursive: true });
    writeFileSync(c.absPath, c.content, 'utf8');
    changeEntries.push({ file: c.relPath, kind: c.existedBefore ? 'modified' : 'created', priorContent: c.priorContent, writtenHash: sha256Hex(c.content) });
  }

  let configChanged = false;
  for (const injectedFile of injectedFiles) {
    writeFileSync(injectedFile.absPath, injectedFile.newContent, 'utf8');
    recordProvenance(config, injectedFile.relPath, provenanceRecord);
    configChanged = true;
    if (injectedFile.changed) {
      changeEntries.push({
        file: injectedFile.relPath,
        kind: 'modified',
        priorContent: injectedFile.originalContent,
        writtenHash: sha256Hex(injectedFile.newContent),
      });
    }
  }

  if (configChanged) saveConfig(repoRoot, config);

  if (changeEntries.length > 0) {
    const changesetId = nextChangesetId();
    writeChangeManifest(repoRoot, changesetId, changeEntries);
    writePending(
      repoRoot,
      changesetId,
      // Track a block when it ships empty (an unfilled stub) or when the pack
      // explicitly marked it `required` (a business-logic seam the host agent
      // must complete even though the shipped placeholder already compiles).
      aiBlocks
        .filter((b) => b.empty || b.required)
        .map((b) => ({ file: b.file, blockIndex: b.blockIndex, startLine: b.startLine, endLine: b.endLine, placeholderContent: b.content })),
    );
    report.changesetId = changesetId;
  }

  return report;
}
