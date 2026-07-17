/**
 * Shared fixture helpers for the Claude Code hooks' integration tests.
 * Mirrors test/integration/testHarness.ts — duplicating rather than importing
 * is intentional so the hook tests don't carry a TS dependency on the
 * engine's test code.
 *
 * Not picked up by the test runner's glob (underscore prefix, non-`.test.mjs`
 * suffix).
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const SCAFFOLD_CLI = path.resolve(REPO_ROOT, 'dist', 'cli.js');

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
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-cc-pack-'));
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
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-cc-target-'));
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

/**
 * Creates a tmpdir with a `scaffold` shell wrapper and returns a factory for
 * child env objects that prepend that tmpdir to PATH (a shell wrapper, not a
 * symlink, for cross-runner safety). Note the hooks prefer the repo's own
 * sibling dist/cli.js when present, so this wrapper only matters for the
 * PATH-fallback branch.
 */
export function setupScaffoldOnPath(coreCliPath) {
  const binDir = mkdtempSync(path.join(tmpdir(), 'scaffold-cc-bindir-'));
  const wrapper = path.join(binDir, 'scaffold');
  writeFileSync(wrapper, `#!/bin/sh\nexec node '${coreCliPath.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  return {
    binDir,
    childEnv: () => ({ ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }),
  };
}

/** Run `node <scriptPath> <args...>` feeding `stdinObj` as JSON on stdin, always resolving with `{ stdout, stderr, status }`. */
export function runHookScript(scriptPath, stdinObj, { cwd, env }) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [scriptPath], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : (typeof err.stderr === 'string' ? err.stderr : ''),
          status: typeof err.code === 'number' ? err.code : 1,
        });
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', status: 0 });
      }
    });
    child.stdin.write(JSON.stringify(stdinObj));
    child.stdin.end();
  });
}

/** Run `node <scriptPath> <args...>` against the given cwd, always resolving with `{ stdout, stderr, status }`. */
export function execWrapper(scriptPath, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
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
