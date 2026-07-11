/**
 * The one real, free, CI-safe test in this suite: actually builds the
 * shared base repo via a local-path pack spec against
 * packages/templates-dotnet/v8-controller and checks a real `dotnet build`
 * succeeds — the same posture as the existing `templates-dotnet-build-check`
 * CI job (packages/templates-dotnet/tools/validate-build.mjs), reusing this
 * module's own dotnetBuild helper rather than a separate implementation.
 *
 * The "materializes a real ... build-passing" test below still skips (not
 * fails) when the .NET SDK isn't on PATH, mirroring validate-build.mjs's own
 * posture — this repo's core CI job doesn't have the .NET SDK installed,
 * only the dedicated templates-dotnet-build-check job does. That guard is
 * still the right call even after fixing dotnetBuild's ENOENT handling
 * below: this particular test wants proof of a genuine successful build,
 * which still requires a real SDK on the machine — the fix only changes
 * what happens when the SDK is absent (a graceful {ok:false}, not a crash),
 * which is what the separate, unconditional "degrades gracefully" test
 * covers instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildBaseRepo, copyBaseRepo, dotnetBuild, removeRepo, CORE_CLI } from '../fixtureRepo.mjs';

const DOTNET_AVAILABLE = spawnSync('dotnet', ['--version']).status === 0;

test('buildBaseRepo materializes a real, dotnet build-passing solution skeleton from the v8-controller pack', { skip: !DOTNET_AVAILABLE && 'dotnet SDK not on PATH' }, () => {
  assert.ok(existsSync(CORE_CLI), `scaffold-core dist not built — run "npm run build" (in packages/core) first (expected ${CORE_CLI})`);

  const baseDir = buildBaseRepo();
  try {
    const build = dotnetBuild(baseDir);
    assert.ok(build.ok, `expected the seeded base repo to build cleanly: ${build.detail}`);
  } finally {
    removeRepo(baseDir);
  }
});

test('dotnetBuild degrades gracefully (returns {ok:false}, never throws) when the dotnet binary cannot be spawned at all', () => {
  const originalPath = process.env.PATH;
  try {
    // An empty PATH guarantees spawnSync cannot resolve `dotnet` regardless
    // of what's really installed on this machine — this reproduces the
    // ENOENT spawn failure dotnetBuild must tell apart from a real "dotnet
    // ran and exited non-zero" case (the bug: `run()` used to throw
    // straight through this exact scenario instead of returning gracefully).
    process.env.PATH = '';
    const result = dotnetBuild(process.cwd());
    assert.equal(result.ok, false);
    assert.match(result.detail, /dotnet SDK not found/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('copyBaseRepo produces an independent copy — mutating the copy does not affect the original base', () => {
  assert.ok(existsSync(CORE_CLI), `scaffold-core dist not built — run "npm run build" (in packages/core) first (expected ${CORE_CLI})`);

  const baseDir = buildBaseRepo();
  const copyDir = copyBaseRepo(baseDir);
  try {
    assert.notEqual(baseDir, copyDir);
    assert.ok(existsSync(copyDir));
    // Same top-level entries in both (a real copy, not an empty dir).
    assert.deepEqual(readdirSync(copyDir).sort(), readdirSync(baseDir).sort());
  } finally {
    removeRepo(baseDir);
    removeRepo(copyDir);
  }
});
