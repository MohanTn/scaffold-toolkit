#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { readOwnPackageJson } from './version/readPkg.js';
import { configPath, saveConfig } from './config/loader.js';
import type { PackConfig } from './config/schema.js';
import { detectProjectType } from './config/projectTypeDetect.js';
import { defaultCacheRoot, syncTemplates } from './templates/sync.js';
import { listTemplateVersions } from './templates/list.js';
import { runGenerate } from './generate/generate.js';
import { renderReport } from './generate/report.js';
import { undoChangeset } from './undo/undo.js';
import { computeStatus } from './status/status.js';
import { runBootstrapMarkers } from './bootstrapMarkers/bootstrapMarkers.js';
import { renderBootstrapMarkersReport } from './bootstrapMarkers/bootstrapMarkersReport.js';
import { validatePack } from './validatePack/validatePack.js';
import { encodeToon } from './toon/codec.js';

const pkg = readOwnPackageJson(import.meta.url);

const program = new Command();
program.name('scaffold').description('Deterministic, LLM-agnostic scaffolding CLI: renders templates and injects marker-based boilerplate for any coding agent to drive.');
program.version(pkg.version, '-v, --version', 'output the installed scaffold-core version');

async function promptProjectType(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('scaffold: could not auto-detect a project type — enter one (e.g. dotnet, js-family, go, python): ');
    const trimmed = answer.trim();
    if (!trimmed) throw new Error('no project type entered');
    return trimmed;
  } finally {
    rl.close();
  }
}

const PACK_SPEC = /^([^=]+)=([^@]+)@(.+)$/;

// scp-style git remote shorthand, e.g. `git@github.com:org/repo.git` — the
// "user@host:" form.
const SCP_STYLE_USER_HOST = /^[\w.-]+@[\w.-]+:/;
// Bare `host:path` scp shorthand with no explicit user, e.g.
// `github.com:org/repo.git` (valid via an ssh config Host alias). Requires a
// dot in the host segment before the colon so a real relative/absolute local
// path is never mistaken for one: `./foo:bar` has no dotted segment before
// its colon, and a Windows drive letter (`C:\foo`) is a single letter with no
// dot at all.
const SCP_STYLE_BARE_HOST = /^[\w.-]+\.[\w.-]+:/;

/**
 * `scaffold init --pack` only ever emits `path`-based entries: a local
 * directory read straight off disk, no git clone. A git-URL-shaped middle
 * segment (a `scheme://` URL or either scp-style shorthand above) is
 * rejected with a pointer to the local-directory spec, rather than silently
 * accepted and later failing deep inside `templates sync`/`generate` — the
 * git/`url` engine itself stays in place underneath for a hypothetical
 * future non-vendored pack, but `init` no longer has any way to produce a
 * `url` entry.
 */
function parsePackSpecs(specs: string[]): Record<string, PackConfig> {
  const packs: Record<string, PackConfig> = {};
  for (const spec of specs) {
    const match = PACK_SPEC.exec(spec);
    if (!match) {
      throw new Error(`invalid --pack "${spec}" — expected name=path@version, e.g. backend=packages/templates-dotnet@v8-controller`);
    }
    const [, name, dir, version] = match;
    if (dir.includes('://') || SCP_STYLE_USER_HOST.test(dir) || SCP_STYLE_BARE_HOST.test(dir)) {
      throw new Error(
        `invalid --pack "${spec}" — "scaffold init" no longer accepts a git URL, point --pack at a local directory instead, e.g. backend=packages/templates-dotnet@v8-controller`,
      );
    }
    packs[name] = { path: dir, version };
  }
  return packs;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command('init')
  .description('Write .scaffold/config.json for this repo')
  .option('--project-type <type>', 'skip auto-detection and use this project type')
  .option('--pack <spec>', 'seed a template pack as name=path@version, e.g. backend=packages/templates-dotnet@v8-controller (repeatable)', collect, [] as string[])
  .action(async (opts: { projectType?: string; pack: string[] }) => {
    try {
      const repoRoot = process.cwd();
      const projectType = opts.projectType ?? detectProjectType(repoRoot) ?? (await promptProjectType());
      const packs = parsePackSpecs(opts.pack);
      saveConfig(repoRoot, { projectType, packs });
      console.log(`scaffold: wrote ${configPath(repoRoot)} (projectType: ${projectType}, packs: ${Object.keys(packs).join(', ') || 'none'})`);
    } catch (error) {
      console.error('scaffold init failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const templates = program.command('templates').description('Manage template pack caches');

templates
  .command('sync')
  .description('Clone or reuse the configured template pack(s) into the local cache')
  .option('--update', 'move each pack\'s pinned SHA forward to the remote HEAD', false)
  .action(async (opts: { update: boolean }) => {
    try {
      const repoRoot = process.cwd();
      const results = await syncTemplates(repoRoot, defaultCacheRoot(repoRoot), { update: opts.update });
      for (const result of results) {
        console.log(`scaffold: ${result.pack} -> ${result.resolvedSha}${result.changed ? ' (updated)' : ''}`);
      }
    } catch (error) {
      console.error('scaffold templates sync failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

templates
  .command('list')
  .description('List available version folders for the configured pack(s)')
  .action(() => {
    try {
      const repoRoot = process.cwd();
      const listings = listTemplateVersions(repoRoot, defaultCacheRoot(repoRoot));
      console.log(encodeToon(listings as unknown as Record<string, unknown>));
    } catch (error) {
      console.error('scaffold templates list failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('generate')
  .description('Render templates and inject marker-based boilerplate from an intent manifest')
  .requiredOption('--manifest <file>', 'intent manifest file (.toon or .json)')
  .option('--dry-run', 'plan without writing anything to disk', false)
  .option('--force', 'overwrite content that would otherwise be refused for differing from a prior injection', false)
  .option('--json', 'print the report as plain JSON instead of TOON', false)
  .action(async (opts: { manifest: string; dryRun: boolean; force: boolean; json: boolean }) => {
    try {
      const report = await runGenerate({ repoRoot: process.cwd(), manifestPath: opts.manifest, dryRun: opts.dryRun, force: opts.force });
      console.log(renderReport(report, opts.json ? 'json' : 'toon'));
    } catch (error) {
      console.error('scaffold generate failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('undo <changesetId>')
  .description('Revert a prior generate run by its changeset id')
  .option('--force', 'discard on-disk edits that no longer match the post-generate hash', false)
  .action((changesetId: string, opts: { force: boolean }) => {
    try {
      undoChangeset(process.cwd(), changesetId, opts.force);
      console.log(`scaffold: undone changeset ${changesetId}`);
    } catch (error) {
      console.error('scaffold undo failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Report whether any AI_IMPLEMENTATION block from a prior generate is still unfilled')
  .option('--json', 'print status as plain JSON instead of TOON', false)
  .action((opts: { json: boolean }) => {
    try {
      const result = computeStatus(process.cwd());
      console.log(opts.json ? JSON.stringify(result, null, 2) : encodeToon(result as unknown as Record<string, unknown>));
      process.exit(result.resolvedAll ? 0 : 1);
    } catch (error) {
      console.error('scaffold status failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('bootstrap-markers')
  .description("Bootstrap empty SCAFFOLD marker pairs into a brownfield repo's existing source files, keyed by the exact configured template-pack version")
  .option('--pack-version <version>', 'override the configured pack version(s), e.g. for a repo without .scaffold/config.json yet or for manual testing')
  .option('--pack <dir>', 'local pack directory (used with --pack-version to test a pack author\'s un-synced descriptor; falls back to the built-in catalog when no descriptor bootstraps the version)')
  .option('--dry-run', 'plan without writing anything to disk', false)
  .option('--json', 'print the report as plain JSON instead of TOON', false)
  .action((opts: { packVersion?: string; pack?: string; dryRun: boolean; json: boolean }) => {
    try {
      const report = runBootstrapMarkers({ repoRoot: process.cwd(), packVersion: opts.packVersion, packDir: opts.pack, dryRun: opts.dryRun });
      console.log(renderBootstrapMarkersReport(report, opts.json ? 'json' : 'toon'));
      process.exit(report.needsManual.length > 0 ? 1 : 0);
    } catch (error) {
      console.error('scaffold bootstrap-markers failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('validate-pack')
  .description('Run a real generate against a synthesized target repo to smoke-test a local template pack (exercises injection, not just rendering)')
  .requiredOption('--pack <dir>', 'path to the local template pack repo')
  .option('--pack-version <version>', 'validate only this version folder (default: every version folder in the pack)')
  .requiredOption('--manifest <file>', 'sample intent manifest (.toon or .json) to drive the generate')
  .option('--json', 'print the report as plain JSON instead of TOON', false)
  .action(async (opts: { pack: string; packVersion?: string; manifest: string; json: boolean }) => {
    try {
      const results = await validatePack({ packDir: opts.pack, version: opts.packVersion, manifestPath: opts.manifest });
      const report = { results, allValid: results.every((r) => r.ok) };
      console.log(opts.json ? JSON.stringify(report, null, 2) : encodeToon(report as unknown as Record<string, unknown>));
      for (const failed of results.filter((r) => !r.ok)) {
        console.error(`scaffold validate-pack: version "${failed.version}" failed: ${failed.error}`);
      }
      process.exit(report.allValid ? 0 : 1);
    } catch (error) {
      console.error('scaffold validate-pack failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error('scaffold: unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
