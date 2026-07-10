/**
 * Dispatch / subcommand integration tests.
 *
 * Isolation discipline (mandatory):
 *   - Every test that calls `captureStd()` must restore `process.{stdout,stderr}.write`
 *     inside a `try/finally`. Without this, an assertion throw inside an `await`
 *     skips `cap.restore()` and leaks a rebound `process.stdout.write` to the
 *     Node test runner — the runner's own TAP output (`ok N - <name>`) flows
 *     into the next test's captured chunk array, and any `JSON.parse` of the
 *     captured output blows up. Tests 1–6 already follow this rule; 7–10 do
 *     too, after a race-condition regression.
 *   - `withScaffoldMissing` restores `process.env.PATH` from its `.finally`,
 *     so PATH doesn't bleed across tests.
 *   - Each test runs scaffold-core in a PATH-missing world — no real
 *     scaffold-core needed for the suite to be green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, parseFlags, buildGeneratePassthrough } from '../src/index.mjs';

function captureStd() {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const chunks = { stdout: [], stderr: [] };
  process.stdout.write = (chunk) => { chunks.stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { chunks.stderr.push(String(chunk)); return true; };
  return {
    out: () => chunks.stdout.join(''),
    err: () => chunks.stderr.join(''),
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

/** Force execFile('scaffold', ...) to fail with ENOENT. */
function withScaffoldMissing(fn) {
  const original = process.env.PATH;
  process.env.PATH = '/usr/local/bin';
  return Promise.resolve().then(fn).finally(() => { process.env.PATH = original; });
}

// ---------- subcommand shape ----------------------------------------------

test('dispatch: --help exits 0 and prints usage mentioning the shim', async () => {
  const cap = captureStd();
  try {
    const code = await dispatch(['--help']);
    assert.equal(code, 0);
    assert.match(cap.out(), /gh-scaffold.*shim.*@mohantn\/scaffold-core/s);
    assert.match(cap.out(), /gh scaffold generate --manifest <file>/);
    assert.match(cap.out(), /Exit codes:/);
  } finally { cap.restore(); }
});

test('dispatch: -v prints the installed version', async () => {
  const cap = captureStd();
  try {
    const code = await dispatch(['-v']);
    assert.equal(code, 0);
    assert.match(cap.out(), /^gh-scaffold \d+\.\d+\.\d+/);
  } finally { cap.restore(); }
});

test('dispatch: unknown subcommand exits 2 with stderr usage hint', async () => {
  const cap = captureStd();
  try {
    const code = await dispatch(['totally-not-a-command']);
    assert.equal(code, 2);
    assert.match(cap.err(), /unknown subcommand "totally-not-a-command"/);
    assert.match(cap.err(), /Run `gh scaffold --help`/);
  } finally { cap.restore(); }
});

test('dispatch: generate without --manifest exits 2 with stderr', async () => {
  const cap = captureStd();
  try {
    const code = await dispatch(['generate']);
    assert.equal(code, 2);
    assert.match(cap.err(), /--manifest <file> is required for `generate`/);
  } finally { cap.restore(); }
});

// ---------- argv parser ----------------------------------------------------

test('parseFlags: --flag value, --flag=value, -x bare-flag, and -- separator', () => {
  const { flags, positional } = parseFlags([
    '--cwd', '/tmp/x',
    '--manifest=/tmp/m.toon',
    '--dry-run',
    '-v',
    '--',
    'leftover', 'args',
  ]);
  assert.equal(flags.cwd, '/tmp/x');
  assert.equal(flags.manifest, '/tmp/m.toon');
  assert.equal(flags['dry-run'], 'true');
  assert.equal(flags.v, 'true');
  assert.deepEqual(positional, ['leftover', 'args']);
});

test('parseFlags: bare tokens are positionals', () => {
  const { flags, positional } = parseFlags(['one', 'two', '--three=4']);
  assert.deepEqual(positional, ['one', 'two']);
  assert.equal(flags.three, '4');
});

// ---------- generate passthrough construction ------------------------------

test('buildGeneratePassthrough forwards --dry-run and --force to scaffold-core', () => {
  assert.deepEqual(buildGeneratePassthrough({ 'dry-run': 'true' }, []), ['--dry-run']);
  assert.deepEqual(buildGeneratePassthrough({ force: 'true' }, []), ['--force']);
  assert.deepEqual(
    buildGeneratePassthrough({ 'dry-run': 'true', force: 'true' }, ['extra']),
    ['--dry-run', '--force', 'extra'],
  );
});

test('buildGeneratePassthrough never forwards --json (shim consumes it for its own envelope format)', () => {
  assert.deepEqual(buildGeneratePassthrough({ json: 'true' }, []), []);
  assert.deepEqual(buildGeneratePassthrough({ json: 'true', 'dry-run': 'true' }, []), ['--dry-run']);
});

test('buildGeneratePassthrough with neither flag set only forwards positionals', () => {
  assert.deepEqual(buildGeneratePassthrough({}, ['a', 'b']), ['a', 'b']);
});

// ---------- precheck-blocked IO branch ------------------------------------

test('dispatch: status --json exits 1 with valid JSON when scaffold binary is missing', async () => {
  const cap = captureStd();
  try {
    await withScaffoldMissing(async () => {
      const code = await dispatch(['status', '--json']);
      assert.equal(code, 1);
      const out = cap.out();
      assert.match(out, /"resolvedAll":\s*false/);
      assert.match(out, /"unresolved":\s*\[\]/);
    });
  } finally { cap.restore(); }
});

test('dispatch: status with scaffold missing prints human-readable stderr and exits 1', async () => {
  const cap = captureStd();
  try {
    await withScaffoldMissing(async () => {
      const code = await dispatch(['status']);
      assert.equal(code, 1);
      assert.match(cap.err(), /gh-scaffold: precheck failed/);
    });
  } finally { cap.restore(); }
});

test('dispatch: generate exits 1 with the blocking refusal when scaffold binary is missing', async () => {
  const cap = captureStd();
  try {
    await withScaffoldMissing(async () => {
      const code = await dispatch(['generate', '--manifest', '/tmp/anything.toon']);
      assert.equal(code, 1);
      assert.match(cap.err(), /gh-scaffold: refusing to generate/);
      assert.match(cap.err(), /Stop-hook guarantee/);
    });
  } finally { cap.restore(); }
});

test('dispatch: generate --json emits the blocked-precheck JSON envelope when scaffold is missing', async () => {
  const cap = captureStd();
  try {
    await withScaffoldMissing(async () => {
      const code = await dispatch(['generate', '--manifest', '/tmp/x.toon', '--json']);
      assert.equal(code, 1);
      // Substring match is more robust than JSON.parse against any
      // captured-output edge cases (binary residue from prior tests, ANSI
      // escapes from the test reporter, etc.). The shape of the envelope is
      // the actual contract being tested.
      const out = cap.out();
      assert.match(out, /"error":\s*"precheck_blocked"/);
      assert.match(out, /"resolvedAll":\s*false/);
    });
  } finally { cap.restore(); }
});
