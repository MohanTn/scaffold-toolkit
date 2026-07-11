/**
 * Builds the identical brownfield base repo both benchmark arms start from,
 * and the `dotnet build` pass/fail check both the base-repo test and the
 * real benchmark run use to grade each arm's output.
 *
 * Pattern follows packages/templates-dotnet/tools/validate-build.mjs
 * closely: a local-path pack spec (`backend=<repo>@packages/templates-dotnet/v8-controller`)
 * against the real `scaffold` CLI, `init` + `templates sync` + one real
 * `generate`, then a real `dotnet build`. That script's `run`/`runOrDie`
 * spawn-helper shape is reused here rather than reimplemented — the only
 * difference is these helpers return a result instead of exiting the
 * process, since fixtureRepo.mjs is a library other modules import, not a
 * standalone CLI entry point.
 *
 * A seed entity ("Seed", not "Order") materializes the full solution
 * skeleton (.sln, Program.cs with markers, AppDbContext, etc.) so both
 * arms start from an identical, `dotnet build`-passing base. The benchmark
 * itself asks each arm to add a separate "Order" entity (prompts.mjs) — the
 * seed and the benchmarked task are deliberately different entities so
 * materializing the base skeleton never overlaps with what each arm is
 * separately asked to build.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const CORE_CLI = join(REPO_ROOT, 'packages', 'core', 'dist', 'cli.js');
export const PACK_SPEC = `backend=${REPO_ROOT}@packages/templates-dotnet/v8-controller`;

// Same shape as packages/templates-dotnet/test_data/*.json: companyProjectName
// + pathConfig are v8-controller's own convention (its templates reference
// them directly), not JSON-schema-required fields — the intent manifest
// schema is additionalProperties:true at the top level, so these ride along
// unvalidated the same way `options` does.
const SEED_MANIFEST = {
  manifestSchemaVersion: 1,
  targetStack: 'backend',
  entity: 'Seed',
  companyProjectName: 'AcmeCorp',
  pathConfig: {
    domainEntities: 'Entities',
    applicationCommonInterfaces: 'Common/Interfaces',
    applicationCommonBehaviors: 'Common/Behaviors',
    applicationCommonExceptions: 'Common/Exceptions',
    applicationFeatures: 'Features',
    infrastructurePersistence: 'Persistence',
    infrastructureConfigurations: 'Persistence/Configurations',
    infrastructureRepositories: 'Persistence/Repositories',
    apiControllers: 'Controllers',
    apiMiddleware: 'Middleware',
    testsApplicationFeatures: 'Features',
  },
  fields: [
    { name: 'id', type: 'Guid' },
    { name: 'name', type: 'string' },
  ],
  options: {
    connectionString: 'Server=(localdb)\\MSSQLLocalDB;Database=AcmeCorpDb;Trusted_Connection=True;',
  },
};

/**
 * Unlike validate-build.mjs's `run` (a CLI entry point, where an ENOENT is
 * just as fatal as any other failure and throwing straight out is correct),
 * this `run` never throws on a spawn failure — it returns the raw
 * spawnSync result, `.error` included, so callers can tell "the process
 * never started at all" (ENOENT: the binary isn't on PATH) apart from "the
 * process ran and exited non-zero" (a real, gradeable failure). Conflating
 * the two here previously meant `dotnetBuild`'s own "dotnet SDK not found"
 * fallback was dead code: `run('dotnet', ...)` threw before that check ever
 * ran, crashing this library (and anything that calls into it, including a
 * live run-benchmark.mjs) instead of degrading gracefully.
 */
function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

/** True when spawnSync couldn't even start the process (e.g. ENOENT), as distinct from the process running and exiting non-zero. */
function spawnFailed(result) {
  return Boolean(result.error);
}

/** Mirrors validate-build.mjs's runOrDie, but returns {ok, detail} instead of exiting the process — this module is a library, not a CLI entry point. */
function runOrDie(label, command, args, cwd) {
  const result = run(command, args, cwd);
  if (spawnFailed(result)) {
    return { ok: false, detail: `${label}: could not start "${command}" (${result.error.code ?? result.error.message}) — is it installed and on PATH?` };
  }
  if (result.status !== 0) {
    return { ok: false, detail: `--- ${label} failed ---\n${result.stdout}\n${result.stderr}` };
  }
  return { ok: true, detail: `${label}: ok` };
}

/**
 * Builds one base repo under a fresh tmpdir and returns its absolute path.
 * Callers that need multiple independent copies (one per benchmark arm)
 * should call this once and `copyBaseRepo` the result — not call this
 * repeatedly — both to avoid paying the (nontrivial) generate/build cost
 * twice and to guarantee every arm starts byte-identical.
 */
export function buildBaseRepo() {
  if (!existsSync(CORE_CLI)) {
    throw new Error(`fixtureRepo: ${CORE_CLI} not built — run "npm run build" (in packages/core) first`);
  }
  const baseDir = mkdtempSync(join(tmpdir(), 'scaffold-benchmark-base-'));

  const init = runOrDie('scaffold init', process.execPath, [CORE_CLI, 'init', '--project-type', 'dotnet', '--pack', PACK_SPEC], baseDir);
  if (!init.ok) throw new Error(init.detail);

  const sync = runOrDie('scaffold templates sync', process.execPath, [CORE_CLI, 'templates', 'sync'], baseDir);
  if (!sync.ok) throw new Error(sync.detail);

  const manifestPath = join(baseDir, 'seed.manifest.json');
  writeFileSync(manifestPath, JSON.stringify(SEED_MANIFEST, null, 2));
  const gen = runOrDie('scaffold generate (seed)', process.execPath, [CORE_CLI, 'generate', '--manifest', manifestPath], baseDir);
  if (!gen.ok) throw new Error(gen.detail);

  return baseDir;
}

/** Copies an existing base repo (from buildBaseRepo) into a fresh tmpdir, for one benchmark arm to mutate independently. */
export function copyBaseRepo(baseDir) {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-benchmark-arm-'));
  cpSync(baseDir, dir, { recursive: true });
  return dir;
}

export function removeRepo(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Runs `dotnet restore` + `dotnet build` against whatever .sln file exists
 * at the root of `repoDir`. Returns {ok, detail} rather than throwing — a
 * failing build is an expected, graded outcome for a benchmark arm, not an
 * exceptional one.
 */
export function dotnetBuild(repoDir) {
  const versionCheck = run('dotnet', ['--version'], repoDir);
  if (spawnFailed(versionCheck) || versionCheck.status !== 0) {
    return { ok: false, detail: 'dotnet SDK not found on PATH' };
  }
  const sln = readdirSync(repoDir).find((name) => name.endsWith('.sln'));
  if (!sln) {
    return { ok: false, detail: 'no .sln file found in the repo' };
  }
  const slnPath = join(repoDir, sln);

  const restore = runOrDie('dotnet restore', 'dotnet', ['restore', slnPath], repoDir);
  if (!restore.ok) return restore;

  return runOrDie('dotnet build', 'dotnet', ['build', slnPath, '--nologo'], repoDir);
}
