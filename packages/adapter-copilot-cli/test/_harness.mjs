/**
 * Shared helpers for the bin-smoke and end-to-end tests.
 *
 * Not picked up by `node --test test/*.test.mjs` (the underscore prefix and the
 * non-`.test.mjs` suffix keep it out of the runner's glob), but importable from
 * any sibling `*.test.mjs` in this directory.
 *
 * Contains:
 *   - Fixture constants and builders (mirror packages/core/test/integration/testHarness.ts
 *     verbatim — duplicating is intentional so the shim's tests don't carry a
 *     TS dependency on the core package's test code).
 *   - `setupScaffoldOnPath(coreCliPath)` — creates a tmpdir with a `scaffold`
 *     shell wrapper that execs `node ${coreCliPath} "$@"`, plus a
 *     `childEnv()` factory that prepends that tmpdir to PATH. Call in a
 *     `before()` once per .test.mjs file.
 *   - `runShim()` / `runCore()` — execFile wrappers that ALWAYS resolve with
 *     `{ stdout, stderr, status }` so callers don't need try/catch boilerplate.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const SHIM_BIN = path.resolve(__dirname, '..', 'bin', 'gh-scaffold');
export const SCAFFOLD_CLI = path.resolve(REPO_ROOT, 'packages', 'core', 'dist', 'cli.js');

// ---------- fixture recipe (mirror packages/core/test/integration/testHarness.ts) ----------

export const PROGRAM_CS = `namespace Fixture;

public static class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        // SCAFFOLD:SCAFFOLD_DI:START
        // SCAFFOLD:SCAFFOLD_DI:END

        var app = builder.Build();

        // SCAFFOLD:SCAFFOLD_ROUTES:START
        // SCAFFOLD:SCAFFOLD_ROUTES:END

        app.Run();
    }
}
`;

const ENDPOINT_TEMPLATE = `namespace Fixture.Endpoints;

public class {{entity}}Endpoint
{
    public void Handle()
    {
        // AI_IMPLEMENTATION_START

        // AI_IMPLEMENTATION_END
    }
}
`;

const DI_TEMPLATE = `        services.AddScoped<I{{entity}}Service, {{entity}}Service>();`;
const ROUTE_TEMPLATE = `        app.MapGet("{{options.route}}", () => Results.Ok());`;

function fixtureDescriptor() {
  return {
    descriptorSchemaVersion: 2,
    packVersion: 'v1',
    requires: { scaffoldCli: '>=0.0.0' },
    targets: [{ output: 'src/Endpoints/{{entity}}Endpoint.cs', template: 'Endpoint.cs.hbs', mode: 'skip-if-exists' }],
    injections: [
      { file: 'Program.cs', marker: 'SCAFFOLD_DI', template: 'di-registration.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' },
      { file: 'Program.cs', marker: 'SCAFFOLD_ROUTES', template: 'route-registration.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' },
    ],
  };
}

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

export function buildFixturePackRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-shim-pack-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Scaffold Test']);
  const v1 = path.join(dir, 'v1');
  mkdirSync(v1, { recursive: true });
  writeFileSync(path.join(v1, 'manifest.templates.json'), JSON.stringify(fixtureDescriptor(), null, 2));
  writeFileSync(path.join(v1, 'Endpoint.cs.hbs'), ENDPOINT_TEMPLATE);
  writeFileSync(path.join(v1, 'di-registration.hbs'), DI_TEMPLATE);
  writeFileSync(path.join(v1, 'route-registration.hbs'), ROUTE_TEMPLATE);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial pack']);
  return dir;
}

export function buildFixtureTargetRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-shim-target-'));
  writeFileSync(path.join(dir, 'Program.cs'), PROGRAM_CS);
  return dir;
}

export function writeManifestFile(targetRepo, entity) {
  const file = path.join(targetRepo, `${entity}.manifest.json`);
  const manifest = {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity,
    fields: [
      { name: 'id', type: 'guid' },
      { name: 'amount', type: 'decimal' },
    ],
    options: { route: `/api/${entity.toLowerCase()}s` },
  };
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

// ---------- scaffold on PATH via shell wrapper ----------

/**
 * Creates a tmpdir with a `scaffold` wrapper script and returns a factory for
 * child env objects that prepend that tmpdir to PATH. Use in `before()`.
 *
 * Why a wrapper instead of a symlink: invoke `scaffold` via `execFile` (i.e.
 * direct exec of a file) needs either (a) a real ELF/shebang executable, or
 * (b) a shell-resolvable name on PATH. A shell wrapper with `#!/bin/sh` and
 * `chmod +x` is unambiguous across every Unix-y CI runner (including the
 * Nix-installed gh environment this shim was developed in). The shim's own
 * `execFile('scaffold', ...)` call finds this wrapper by name.
 *
 * NOTE: this helper does NOT validate that coreCliPath exists. Callers that
 * need scaffold-core must assert that explicitly (with a clear message),
 * because silent skips risk masking a broken `npm run build` in CI.
 */
export function setupScaffoldOnPath(coreCliPath) {
  const binDir = mkdtempSync(path.join(tmpdir(), 'scaffold-shim-bindir-'));
  const wrapper = path.join(binDir, 'scaffold');
  // Single-quoted heredoc-on-shell would also work but writing the file
  // explicitly is clearer and sidesteps any quoting edge cases around
  // coreCliPath containing spaces (very unlikely but worth not assuming).
  writeFileSync(wrapper, `#!/bin/sh\nexec node '${coreCliPath.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  return {
    binDir,
    childEnv: () => ({ ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }),
  };
}

/**
 * Run `node <scriptPath> <args...>` against the given cwd, always resolving
 * with `{ stdout, stderr, status }`. Mirrors pattern in
 * `packages/core/test/integration/cli.test.ts`.
 */
export function execWrapper(scriptPath, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // execFile-style failure: status defaults to 1 if not set.
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : (typeof err.stderr === 'string' ? err.stderr : ''),
          status: typeof err.code === 'number' ? err.code : 1,
        });
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', status: 0 });
      }
    });
  });
}
