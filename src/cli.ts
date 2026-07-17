#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { readOwnPackageJson } from './version/readPkg.js';
import { configPath, saveConfig } from './config/loader.js';
import type { PackConfig } from './config/schema.js';
import { isPathPack } from './config/schema.js';
import { detectProjectType } from './config/projectTypeDetect.js';
import { defaultCacheRoot, syncTemplates, cacheLocalPack } from './templates/sync.js';
import { listTemplateVersions } from './templates/list.js';
import { runGenerate } from './generate/generate.js';
import { renderReport, renderReportAsDoc } from './generate/report.js';
import { undoChangeset } from './undo/undo.js';
import { computeStatus } from './status/status.js';
import { computeNext } from './next/next.js';
import { runBootstrapMarkers } from './bootstrapMarkers/bootstrapMarkers.js';
import { renderBootstrapMarkersReport } from './bootstrapMarkers/bootstrapMarkersReport.js';
import { validatePack } from './validatePack/validatePack.js';
import { encodeToon } from './toon/codec.js';
import { checkEdit } from './checkEdit/checkEdit.js';
import { createPackSkeleton } from './packNew/packNew.js';
import type { CheckEditTool } from './checkEdit/checkEdit.js';
import { buildIntentManifest } from './manifest/build.js';
import { runAdd } from './add/runAdd.js';
import { compileAddFeature } from './add/addFeature.js';
import { compileAddCustom } from './add/addCustom.js';
import { compileAddArtifact, ARTIFACT_KINDS } from './add/addArtifact.js';
import type { AddRunFlags } from './add/common.js';

const pkg = readOwnPackageJson(import.meta.url);

const program = new Command();
program.name('scaffold').description('Deterministic, LLM-agnostic scaffolding CLI: renders templates and injects marker-based boilerplate for any coding agent to drive.');
program.version(pkg.version, '-v, --version', 'output the installed scaffold-core version');
program.showHelpAfterError('(run "scaffold <command> --help" for usage)');
program.showSuggestionAfterError(true);
program.addHelpText(
  'after',
  `
Typical flow:
  $ scaffold init --pack backend=templates/templates-dotnet@csharp-enterprise
  $ scaffold add feature --name Product --properties "Name:string,Price:decimal"
  $ scaffold add custom --name GetProductsWithFilter --return-type PagedResult --parameters "page:int,pageSize:int" --target-controller ProductsController
  $ scaffold next        # what AI_IMPLEMENTATION blocks still need business logic
  $ scaffold status      # exits non-zero while any block is unfilled

The low-level layer stays available for scripted/manifest-driven use:
  $ scaffold manifest new --stack backend --entity Invoice --field Amount:decimal --artifact base --artifact op-create --out invoice.manifest.json
  $ scaffold generate --manifest invoice.manifest.json --dry-run

Run "scaffold <command> --help" for per-command options and examples.
Docs: https://github.com/MohanTn/scaffold-toolkit#readme`,
);

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
      throw new Error(`invalid --pack "${spec}" — expected name=path@version, e.g. backend=templates/templates-dotnet@csharp-enterprise`);
    }
    const [, name, dir, version] = match;
    if (dir.includes('://') || SCP_STYLE_USER_HOST.test(dir) || SCP_STYLE_BARE_HOST.test(dir)) {
      throw new Error(
        `invalid --pack "${spec}" — "scaffold init" no longer accepts a git URL, point --pack at a local directory instead, e.g. backend=templates/templates-dotnet@csharp-enterprise`,
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
  .summary('write .scaffold/config.json for this repo')
  .description('Write .scaffold/config.json for this repo: records the project type (auto-detected unless overridden) and the template pack(s) later commands resolve against.')
  .option('--project-type <type>', 'skip auto-detection and use this project type')
  .option('--pack <spec>', 'seed a template pack as name=path@version, e.g. backend=templates/templates-dotnet@csharp-enterprise (repeatable)', collect, [] as string[])
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold init
  $ scaffold init --project-type dotnet
  $ scaffold init --pack backend=templates/templates-dotnet@csharp-enterprise`,
  )
  .action(async (opts: { projectType?: string; pack: string[] }) => {
    try {
      const repoRoot = process.cwd();
      const projectType = opts.projectType ?? detectProjectType(repoRoot) ?? (await promptProjectType());
      const packs = parsePackSpecs(opts.pack);
      // Copies each seeded pack into .scaffold/cache immediately and rewrites
      // its `path` to the cache dir — generate/list/etc. keep reading `path`
      // straight off disk exactly as before, but that disk location is now a
      // local cache entry instead of the original --pack source, so the repo
      // no longer depends on that source directory staying reachable.
      const cacheRoot = defaultCacheRoot(repoRoot);
      for (const [name, pack] of Object.entries(packs)) {
        if (!isPathPack(pack)) continue; // parsePackSpecs only ever emits path-based entries; guard is purely for narrowing
        const cachedDir = cacheLocalPack(repoRoot, cacheRoot, pack.path);
        packs[name] = { ...pack, path: path.relative(repoRoot, cachedDir) };
      }
      saveConfig(repoRoot, { projectType, packs });
      console.log(`scaffold: wrote ${configPath(repoRoot)} (projectType: ${projectType}, packs: ${Object.keys(packs).join(', ') || 'none'})`);
    } catch (error) {
      console.error('scaffold init failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const manifest = program.command('manifest').description('Author intent manifests');

manifest
  .command('new')
  .summary('build a schema-validated intent manifest from flags')
  .description('Build a schema-validated intent manifest from a compact spec, without hand-writing the JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold manifest new --stack backend --entity Invoice --field Amount:decimal --field DueDate:DateTime
  $ scaffold manifest new --stack backend --entity Order --option database.provider=sqlite --out order.manifest.json
  $ scaffold manifest new --stack frontend --input name=MyModule`,
  )
  .requiredOption('--stack <targetStack>', 'targetStack the manifest is for, matching a pack name in .scaffold/config.json')
  .option('--entity <name>', 'PascalCase entity name, for packs that take one')
  .option('--field <name:type>', 'entity field as name:type, e.g. Amount:decimal (repeatable)', collect, [] as string[])
  .option('--option <path=value>', 'manifest option as dot-path=value, e.g. database.provider=sqlite (repeatable)', collect, [] as string[])
  .option('--input <name=value>', 'manifest input as name=value, e.g. name=MyModule (repeatable)', collect, [] as string[])
  .option('--artifact <tag>', 'render only descriptor entries carrying this artifact tag; untagged entries are "base" (repeatable)', collect, [] as string[])
  .option('--out <file>', 'write the manifest to this file instead of stdout')
  .action((opts: { stack: string; entity?: string; field: string[]; option: string[]; input: string[]; artifact: string[]; out?: string }) => {
    try {
      const built = buildIntentManifest({
        targetStack: opts.stack,
        entity: opts.entity,
        fields: opts.field,
        options: opts.option,
        inputs: opts.input,
        artifacts: opts.artifact,
      });
      const json = `${JSON.stringify(built, null, 2)}\n`;
      if (opts.out) {
        writeFileSync(opts.out, json);
        console.log(`scaffold: wrote ${opts.out}`);
      } else {
        process.stdout.write(json);
      }
    } catch (error) {
      console.error('scaffold manifest new failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// scaffold add — the spec-style, entity-first command family. Each subcommand
// is a thin, pure compiler from flags to an artifact-scoped intent manifest,
// run through the exact same generate pipeline as `scaffold generate`.
// ---------------------------------------------------------------------------

const add = program
  .command('add')
  .summary('generate enterprise artifacts with entity-first flags (feature, custom, domain-event, …)')
  .description(
    'Generate boilerplate for one artifact at a time — a CRUD feature, a custom endpoint on an existing controller, a domain event, a factory, and more. ' +
      'Compiles the flags into an artifact-scoped intent manifest and runs the same deterministic generate pipeline; AI_IMPLEMENTATION blocks mark exactly where business logic goes.',
  );

/** The report/run flags every add subcommand shares. */
function withRunFlags(cmd: Command): Command {
  return cmd
    .option('--dry-run', 'plan without writing anything to disk', false)
    .option('--force', 'overwrite content that would otherwise be refused for differing from a prior injection', false)
    .option('--json', 'print the report as plain JSON instead of TOON', false)
    .option('--format <format>', 'print the report as a human-readable doc instead of TOON/JSON — only useful value today is "doc"')
    .option('--template-set <slot>', 'pack slot from .scaffold/config.json (default: the only configured slot)');
}

function runFlagsOf(opts: Record<string, unknown>): AddRunFlags {
  return {
    dryRun: opts.dryRun as boolean,
    force: opts.force as boolean,
    json: opts.json as boolean,
    format: opts.format as string | undefined,
    templateSet: opts.templateSet as string | undefined,
  };
}

async function addAction(kind: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`scaffold add ${kind} failed:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

withRunFlags(
  add
    .command('feature')
    .summary('full CRUD feature for a new entity')
    .description('Generate a full CRUD feature (or a subset of operations) for a new entity: commands/queries, handlers, validators, DTOs, repository, controller, and DI wiring.'),
)
  .requiredOption('--name <Entity>', 'entity name (singular, PascalCase), e.g. Product')
  .requiredOption('--properties <list>', 'comma-separated "Name:type" pairs, e.g. "Name:string,Price:decimal"')
  .option('--db <scope>', 'database scope the pack understands, e.g. Master or Tenant')
  .option('--operations <list>', 'operations to generate: any of Create,Read,Update,Delete (default: all four)')
  .option('--controller <name>', 'controller to create or extend (default: the pack\'s pluralized convention)')
  .option('--namespace <ns>', 'override the base namespace for generated files')
  .option('--target <folder>', 'target architecture folder passed to the pack as options.targetFolder')
  .option('--combine', 'repository interface + implementation in a single file')
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold add feature --name Product --properties "Name:string,Price:decimal,IsActive:bool"
  $ scaffold add feature --name Campaign --properties "Name:string,Budget:decimal" --operations Create,Read --combine
  $ scaffold add feature --name Invoice --properties "Amount:decimal" --dry-run --format doc`,
  )
  .action(async (opts: Record<string, unknown>) => {
    await addAction('feature', () =>
      runAdd(
        process.cwd(),
        (targetStack) =>
          compileAddFeature({
            targetStack,
            name: opts.name as string,
            properties: opts.properties as string,
            db: opts.db as string | undefined,
            operations: opts.operations as string | undefined,
            controller: opts.controller as string | undefined,
            namespace: opts.namespace as string | undefined,
            target: opts.target as string | undefined,
            combine: opts.combine as boolean | undefined,
          }),
        runFlagsOf(opts),
      ),
    );
  });

withRunFlags(
  add
    .command('custom')
    .summary('custom query/command endpoint on an existing controller')
    .description(
      'Generate a custom operation — a query or command with its handler and DTO — and inject the action into an existing controller plus the method into the existing repository (interface and implementation), all at scaffold markers.',
    ),
)
  .requiredOption('--name <Operation>', 'operation name (PascalCase), e.g. GetProductsWithFilter')
  .requiredOption('--return-type <type>', 'return type of the operation, e.g. PagedResult or ProductStatisticsDto')
  .option('--parameters <list>', 'comma-separated "name:type" pairs, e.g. "categoryId:int,page:int"')
  .option('--method <verb>', 'HTTP method: GET, POST, PUT, DELETE, or PATCH (default: GET)')
  .option('--route <template>', 'route template, e.g. "api/v2/products/filter" (default: derived by the pack)')
  .option('--target-controller <name>', 'existing controller to extend, e.g. ProductsController')
  .option('--entity <Entity>', 'entity the operation belongs to (default: derived from --target-controller)')
  .option('--is-command', 'generate a command instead of a query (mutating operation)')
  .option('--combine', 'the target repository uses the combined interface+implementation layout')
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold add custom --name GetProductsWithFilter --return-type PagedResult --parameters "page:int,pageSize:int" --method GET --route "api/v2/products/filter" --target-controller ProductsController
  $ scaffold add custom --name ArchiveProduct --return-type Unit --is-command --target-controller ProductsController`,
  )
  .action(async (opts: Record<string, unknown>) => {
    await addAction('custom', () =>
      runAdd(
        process.cwd(),
        (targetStack) =>
          compileAddCustom({
            targetStack,
            name: opts.name as string,
            returnType: opts.returnType as string,
            parameters: opts.parameters as string | undefined,
            method: opts.method as string | undefined,
            route: opts.route as string | undefined,
            targetController: opts.targetController as string | undefined,
            entity: opts.entity as string | undefined,
            isCommand: opts.isCommand as boolean | undefined,
            combine: opts.combine as boolean | undefined,
          }),
        runFlagsOf(opts),
      ),
    );
  });

interface ArtifactSubcommand {
  kind: string;
  summary: string;
  flags: Array<{ spec: string; help: string }>;
  example: string;
}

const ARTIFACT_SUBCOMMANDS: ArtifactSubcommand[] = [
  {
    kind: 'domain-event',
    summary: 'domain event record + handler stub',
    flags: [
      { spec: '--name <EventName>', help: 'event name (PascalCase), e.g. ProductCreated' },
      { spec: '--entity <Entity>', help: 'entity the event belongs to (optional)' },
    ],
    example: 'scaffold add domain-event --name ProductCreated --entity Product',
  },
  {
    kind: 'factory',
    summary: 'domain factory that enforces invariants',
    flags: [{ spec: '--entity <Entity>', help: 'entity the factory creates, e.g. Product' }],
    example: 'scaffold add factory --entity Product',
  },
  {
    kind: 'helper',
    summary: 'helper class (guard clauses or crypto utilities)',
    flags: [{ spec: '--name <helper>', help: '"guard" or "crypto"' }],
    example: 'scaffold add helper --name guard',
  },
  {
    kind: 'cloud-provider',
    summary: 'cloud storage provider abstraction + implementation',
    flags: [{ spec: '--provider <name>', help: 'aws, azure, or gcp' }],
    example: 'scaffold add cloud-provider --provider azure',
  },
  {
    kind: 'scheduler-job',
    summary: 'background job (Quartz or Hangfire)',
    flags: [
      { spec: '--name <JobName>', help: 'job name (PascalCase), e.g. NightlyCleanup' },
      { spec: '--scheduler <name>', help: 'quartz or hangfire' },
    ],
    example: 'scaffold add scheduler-job --name NightlyCleanup --scheduler quartz',
  },
  {
    kind: 'health-check',
    summary: 'health check class + endpoint registration',
    flags: [{ spec: '--name <CheckName>', help: 'check name (PascalCase), e.g. Database' }],
    example: 'scaffold add health-check --name Database',
  },
  {
    kind: 'outbox-processor',
    summary: 'outbox pattern: message entity + background processor',
    flags: [],
    example: 'scaffold add outbox-processor',
  },
  {
    kind: 'component',
    summary: 'React component + CSS module + test, exported from the components barrel',
    flags: [{ spec: '--name <ComponentName>', help: 'component name (PascalCase), e.g. Button' }],
    example: 'scaffold add component --name Button',
  },
  {
    kind: 'hook',
    summary: 'custom React hook + test, exported from the hooks barrel',
    flags: [{ spec: '--name <HookName>', help: 'hook name (PascalCase, "use" prefix), e.g. UseToggle' }],
    example: 'scaffold add hook --name UseToggle',
  },
  {
    kind: 'page',
    summary: 'page-level component + test, exported from the pages barrel',
    flags: [{ spec: '--name <PageName>', help: 'page name (PascalCase), e.g. ProductsPage' }],
    example: 'scaffold add page --name ProductsPage',
  },
  {
    kind: 'context',
    summary: 'React context provider + hook + test, exported from the context barrel',
    flags: [{ spec: '--name <ContextName>', help: 'context name (PascalCase), e.g. Auth' }],
    example: 'scaffold add context --name Auth',
  },
  {
    kind: 'api-client',
    summary: 'fetch-based REST client (getAll/getById/create/update/remove) + test, exported from the api barrel',
    flags: [{ spec: '--name <ResourceName>', help: 'resource name (PascalCase), e.g. Products' }],
    example: 'scaffold add api-client --name Products',
  },
];

for (const sub of ARTIFACT_SUBCOMMANDS) {
  const cmd = withRunFlags(add.command(sub.kind).summary(sub.summary).description(`Generate ${sub.summary} from the configured template pack.`));
  for (const flag of sub.flags) cmd.option(flag.spec, flag.help);
  cmd.addHelpText('after', `\nExample:\n  $ ${sub.example}`);
  cmd.action(async (opts: Record<string, unknown>) => {
    await addAction(sub.kind, () =>
      runAdd(
        process.cwd(),
        (targetStack) =>
          compileAddArtifact(sub.kind, {
            targetStack,
            name: opts.name as string | undefined,
            entity: opts.entity as string | undefined,
            provider: opts.provider as string | undefined,
            scheduler: opts.scheduler as string | undefined,
          }),
        runFlagsOf(opts),
      ),
    );
  });
}

// Every table row must be a wired subcommand and vice versa — a mismatch is a
// programming error caught at CLI startup, not at first use.
{
  const tableKinds = Object.keys(ARTIFACT_KINDS).sort();
  const wiredKinds = ARTIFACT_SUBCOMMANDS.map((s) => s.kind).sort();
  if (JSON.stringify(tableKinds) !== JSON.stringify(wiredKinds)) {
    throw new Error(`scaffold add: artifact kinds out of sync — table has [${tableKinds.join(', ')}], CLI wires [${wiredKinds.join(', ')}]`);
  }
}

const pack = program.command('pack').description('Author new template packs');

pack
  .command('new')
  .summary('scaffold a new, minimal template pack skeleton')
  .description(
    'Write a schema-valid, empty manifest.templates.json (no targets/injections/inputs yet) under <dir>/<version>/, plus a tools/validate-build.mjs stub under <dir>/tools/ — the smallest starting point "scaffold validate-pack" accepts unmodified. The author adds their first target, template, and test_data fixture by hand.',
  )
  .requiredOption('--dir <path>', 'the pack\'s root directory (created if missing), e.g. templates/templates-go')
  .requiredOption('--pack-version <version>', 'the version folder to create under --dir, e.g. v1')
  .option('--stack <label>', 'a descriptive label (e.g. "backend") noted in the generated files\' comments; not enforced')
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold pack new --dir templates/templates-go --pack-version v1
  $ scaffold pack new --dir ./my-pack --pack-version v1 --stack backend

Next steps once the skeleton exists: add targets[]/injections[]/inputs[] to
the descriptor, author .hbs templates, add test_data/ fixtures, then replace
the validate-build.mjs stub with a real toolchain build-check.`,
  )
  .action((opts: { dir: string; packVersion: string; stack?: string }) => {
    try {
      const result = createPackSkeleton({ dir: opts.dir, version: opts.packVersion, stack: opts.stack });
      console.log(`scaffold: wrote ${result.descriptorPath}`);
      console.log(`scaffold: wrote ${result.validateBuildPath}`);
    } catch (error) {
      console.error('scaffold pack new failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

const templates = program.command('templates').description('Manage template pack caches');

templates
  .command('sync')
  .summary('clone or reuse configured pack(s) into the local cache')
  .description('Clone or reuse the configured template pack(s) into the local cache')
  .option('--update', 'move each pack\'s pinned SHA forward to the remote HEAD', false)
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold templates sync
  $ scaffold templates sync --update`,
  )
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
  .summary('list available version folders for configured pack(s)')
  .description('List available version folders for the configured pack(s)')
  .addHelpText(
    'after',
    `
Example:
  $ scaffold templates list`,
  )
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
  .summary('render templates and inject boilerplate from a manifest')
  .description('Render templates and inject marker-based boilerplate from an intent manifest')
  .requiredOption('--manifest <file>', 'intent manifest file (.toon or .json)')
  .option('--dry-run', 'plan without writing anything to disk', false)
  .option('--force', 'overwrite content that would otherwise be refused for differing from a prior injection', false)
  .option('--json', 'print the report as plain JSON instead of TOON', false)
  .option('--format <format>', 'print the report as a curated, human-readable preflight doc instead of TOON/JSON — only useful value today is "doc" (pairs naturally with --dry-run)')
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold generate --manifest invoice.manifest.json --dry-run
  $ scaffold generate --manifest invoice.manifest.json --dry-run --format doc
  $ scaffold generate --manifest invoice.manifest.json
  $ scaffold generate --manifest invoice.manifest.toon --force --json

The report lists every file created/injected plus any AI_IMPLEMENTATION blocks
left for the agent to fill; check them with "scaffold status". "--dry-run
--format doc" renders the same data as a readable preflight before committing
to a real run.`,
  )
  .action(async (opts: { manifest: string; dryRun: boolean; force: boolean; json: boolean; format?: string }) => {
    try {
      const report = await runGenerate({ repoRoot: process.cwd(), manifestPath: opts.manifest, dryRun: opts.dryRun, force: opts.force });
      console.log(opts.format === 'doc' ? renderReportAsDoc(report) : renderReport(report, opts.json ? 'json' : 'toon'));
    } catch (error) {
      console.error('scaffold generate failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('undo <changesetId>')
  .summary('revert a prior generate run by its changeset id')
  .description('Revert a prior generate run by its changeset id (printed in the generate report)')
  .option('--force', 'discard on-disk edits that no longer match the post-generate hash', false)
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold undo 1752345600000-000001
  $ scaffold undo 1752345600000-000001 --force

Changeset ids are printed in the generate report and listed under .scaffold/changes/.`,
  )
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
  .summary('report unfilled AI_IMPLEMENTATION blocks')
  .description('Report whether any AI_IMPLEMENTATION block from a prior generate is still unfilled (exit 0 when all resolved, 1 otherwise)')
  .option('--json', 'print status as plain JSON instead of TOON', false)
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold status
  $ scaffold status --json`,
  )
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
  .command('next')
  .summary('list open AI_IMPLEMENTATION work as a compact digest')
  .description(
    'List every still-open (required or empty) AI_IMPLEMENTATION block from prior generate runs as a compact per-block digest — file, line range, and current placeholder body — so a host agent can fill implementation work straight from this output instead of re-reading every generated file to find these blocks',
  )
  .option('--json', 'print the digest as plain JSON instead of TOON', false)
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold next
  $ scaffold next --json

Exits 0 when nothing is open (matching "scaffold status"), 1 otherwise.`,
  )
  .action((opts: { json: boolean }) => {
    try {
      const result = computeNext(process.cwd());
      console.log(opts.json ? JSON.stringify(result, null, 2) : encodeToon(result as unknown as Record<string, unknown>));
      process.exit(result.done ? 0 : 1);
    } catch (error) {
      console.error('scaffold next failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('bootstrap-markers')
  .summary('adopt a brownfield repo into pack ownership')
  .description(
    "Adopt a brownfield repo into pack ownership: maps each configured pack's targets/injections to the repo's real files (persisted to .scaffold/config.json's adoptedPaths, so check-edit gates them like generated files), and bootstraps empty SCAFFOLD marker pairs where an anchor is known",
  )
  .option('--pack-version <version>', 'override the configured pack version(s), e.g. for a repo without .scaffold/config.json yet or for manual testing')
  .option('--pack <dir>', 'local pack directory (used with --pack-version to test a pack author\'s un-synced descriptor; falls back to the built-in catalog when no descriptor bootstraps the version)')
  .option('--dry-run', 'plan without writing anything to disk', false)
  .option('--json', 'print the report as plain JSON instead of TOON', false)
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold bootstrap-markers --dry-run
  $ scaffold bootstrap-markers --json
  $ scaffold bootstrap-markers --pack-version csharp-enterprise --pack ./my-pack --dry-run

Exits 1 while any marker or mapping still needs manual placement.`,
  )
  .action((opts: { packVersion?: string; pack?: string; dryRun: boolean; json: boolean }) => {
    try {
      const report = runBootstrapMarkers({ repoRoot: process.cwd(), packVersion: opts.packVersion, packDir: opts.pack, dryRun: opts.dryRun });
      console.log(renderBootstrapMarkersReport(report, opts.json ? 'json' : 'toon'));
      process.exit(report.needsManual.length > 0 || report.mappingNeedsManual.length > 0 ? 1 : 0);
    } catch (error) {
      console.error('scaffold bootstrap-markers failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('validate-pack')
  .summary('smoke-test a local template pack via a real generate')
  .description('Run a real generate against a synthesized target repo to smoke-test a local template pack (exercises injection, not just rendering)')
  .requiredOption('--pack <dir>', 'path to the local template pack repo')
  .option('--pack-version <version>', 'validate only this version folder (default: every version folder in the pack)')
  .requiredOption('--manifest <file>', 'sample intent manifest (.toon or .json) to drive the generate')
  .option('--json', 'print the report as plain JSON instead of TOON', false)
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold validate-pack --pack templates/templates-dotnet --manifest templates/templates-dotnet/test_data/order.manifest.json
  $ scaffold validate-pack --pack ./my-pack --pack-version v1 --manifest ./my-pack/test_data/sample.manifest.json --json

Note: this only proves generate does not throw — pair it with the pack's own
build-check (tools/validate-build.mjs) to catch compile errors in the output.`,
  )
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

program
  .command('check-edit')
  .summary('gate a proposed write/edit against pack ownership')
  .description('Check whether a proposed write/edit to a file is permitted under the configured template pack(s) — the structural gate the host-adapter PreToolUse hooks shell out to before letting a Write/Edit tool call run')
  .requiredOption('--file <path>', 'the file the tool call targets (absolute or repo-relative)')
  .requiredOption('--tool <write|edit>', 'the kind of file operation being attempted')
  .option('--old-string <text>', "the edit tool's old_string; required (in some form) for --tool edit, ignored for --tool write")
  .option('--old-string-file <path>', "read --old-string's value from a file instead of the command line, avoiding shell-escaping a multi-line string")
  .addHelpText(
    'after',
    `
Examples:
  $ scaffold check-edit --file src/Endpoints/InvoiceEndpoint.cs --tool write
  $ scaffold check-edit --file src/Program.cs --tool edit --old-string "AddScoped<IInvoiceRepository"
  $ scaffold check-edit --file src/Program.cs --tool edit --old-string-file /tmp/old-string.txt

Prints a JSON decision ({"allow":true|false,...}); exit 0 allows, exit 1 blocks.`,
  )
  .action((opts: { file: string; tool: string; oldString?: string; oldStringFile?: string }) => {
    try {
      if (opts.tool !== 'write' && opts.tool !== 'edit') {
        throw new Error(`--tool must be "write" or "edit", got "${opts.tool}"`);
      }
      const oldString = opts.oldStringFile ? readFileSync(opts.oldStringFile, 'utf8') : opts.oldString;
      const result = checkEdit({ repoRoot: process.cwd(), file: opts.file, tool: opts.tool as CheckEditTool, oldString });
      console.log(JSON.stringify(result));
      process.exit(result.allow ? 0 : 1);
    } catch (error) {
      console.error('scaffold check-edit failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error('scaffold: unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
