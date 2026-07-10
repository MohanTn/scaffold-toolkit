/**
 * Full shim end-to-end integration test.
 *
 * Mirrors the README's manual-verification recipe end to end (steps 3–6):
 *
 *   3.  In a fresh fixture target dir: `scaffold init` + `scaffold templates sync`.
 *   4.  Run `gh scaffold generate --manifest <manifest>` — block intentionally
 *       unfilled — confirm exit 0, file created, AI_IMPLEMENTATION entry on stdout.
 *   5.  Run `gh scaffold generate` again with the block still unfilled —
 *       confirm exit 1 with the pending-block list on stderr AND no file write.
 *   6.  Fill the block (the host agent's edit step), then re-run `gh scaffold
 *       generate` — confirm exit 0 and post-fill `gh scaffold status --json`
 *       reports resolvedAll=true.
 *
 * Why drive scaffold-core directly for `init` and `templates sync`? The shim
 * dispatcher (src/index.mjs) only exposes `status` and `generate` as
 * subcommands. Init and templates sync setup are core's job, not the shim's;
 * the manual-verification recipe in the README also calls those on core
 * directly. We call them via `node ${SCAFFOLD_CLI} init ...` and pass
 * `cwd=<fixture target>`; same as if the user typed `npx scaffold ...`.
 *
 * Setup strategy: spawn everything via `child_process.execFile(node, ...)`.
 * `process.env.PATH` is NOT mutated — each child receives an explicit `env`
 * with a private tmpdir prepended. The private tmpdir holds a single shell
 * wrapper named `scaffold` (see _harness.mjs) that `exec`s node against the
 * core dist path. This keeps the parent test process clean and matches how
 * the shim itself resolves scaffold-core (execFile('scaffold', ...) looks
 * up `scaffold` on PATH inside the spawned env).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCAFFOLD_CLI,
  SHIM_BIN,
  setupScaffoldOnPath,
  buildFixturePackRepo,
  buildFixtureTargetRepo,
  writeManifestFile,
  execWrapper,
} from './_harness.mjs';

let envFactory;
before(() => {
  assert.ok(existsSync(SCAFFOLD_CLI), `scaffold-core dist not built — run \`npm run build\` first (expected ${SCAFFOLD_CLI})`);
  const setup = setupScaffoldOnPath(SCAFFOLD_CLI);
  envFactory = setup.childEnv;
});

test('end-to-end: shim against real scaffold-core install — init, sync, generate, precheck refuses, fill, regenerate', async () => {
  const env = envFactory();

  // ---- recipe step 3a: scaffold init -------------------------------------------
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  const initResult = await execWrapper(SCAFFOLD_CLI, ['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], { cwd: targetRepo, env });
  assert.equal(initResult.status, 0, `scaffold init failed: ${JSON.stringify(initResult)}`);
  assert.ok(existsSync(path.join(targetRepo, '.scaffold', 'config.json')), 'init did not create .scaffold/config.json');

  // ---- recipe step 3b: scaffold templates sync --------------------------------
  const syncResult = await execWrapper(SCAFFOLD_CLI, ['templates', 'sync'], { cwd: targetRepo, env });
  assert.equal(syncResult.status, 0, `scaffold templates sync failed: ${JSON.stringify(syncResult)}`);
  const configAfterSync = JSON.parse(readFileSync(path.join(targetRepo, '.scaffold', 'config.json'), 'utf8'));
  // The pack URL got pinned to a real sha after the local clone — proves the
  // sync actually talked to the fixture pack, not just exited 0 by accident.
  assert.ok(configAfterSync.packs.backend.pinnedSha, `templates sync did not pin a sha; got ${JSON.stringify(configAfterSync)}`);

  // ---- baseline status through the shim ---------------------------------------
  const statusBaseline = await execWrapper(SHIM_BIN, ['status', '--json'], { cwd: targetRepo, env });
  assert.equal(statusBaseline.status, 0, `baseline shim status failed: ${JSON.stringify(statusBaseline)}`);
  assert.deepEqual(JSON.parse(statusBaseline.stdout), { resolvedAll: true, unresolved: [] });

  // ---- recipe step 4: first generate (block deliberately left unfilled) -------
  // IMPORTANT: the shim does NOT forward `--json` to scaffold-core — that
  // flag is consumed by the shim itself for its own precheck envelope, but
  // scaffold-core's stdout comes back TOON-formatted in the success path.
  // The README's "Pass-through flags" section documents this precisely (see
  // `buildGeneratePassthrough` in `src/index.mjs`); the test mirrors the
  // actual manual-verification recipe, which runs `gh scaffold generate`
  // with no `--json` and inspects side effects.
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  // --dry-run MUST reach scaffold-core and MUST NOT write anything — this is
  // the regression test for a real bug where --dry-run/--force were silently
  // swallowed by the shim's own flag parser instead of being forwarded.
  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const dryRun = await execWrapper(SHIM_BIN, ['generate', '--manifest', manifestFile, '--dry-run'], { cwd: targetRepo, env });
  assert.equal(dryRun.status, 0, `dry-run generate failed: ${JSON.stringify(dryRun)}`);
  assert.ok(!existsSync(endpointPath), '--dry-run through the shim must not write scaffold-core output to disk');

  const gen1 = await execWrapper(SHIM_BIN, ['generate', '--manifest', manifestFile], { cwd: targetRepo, env });
  assert.equal(gen1.status, 0, `first generate failed: ${JSON.stringify(gen1)}`);
  assert.ok(gen1.stdout.length > 0, 'expected scaffold-core TOON report on stdout from first generate');

  const programPath = path.join(targetRepo, 'Program.cs');
  assert.ok(existsSync(endpointPath), 'endpoint file was not written by first generate');
  const endpointContent = readFileSync(endpointPath, 'utf8');
  assert.match(endpointContent, /public class InvoiceEndpoint/);

  // Two independent SCAFFOLD markers injected into Program.cs (DI + Routes).
  // Asserted at the filesystem level instead of the (TOON) report level so
  // we don't couple to wire-format details.
  const programContent = readFileSync(programPath, 'utf8');
  assert.match(programContent, /services\.AddScoped<IInvoiceService, InvoiceService>\(\);/);
  assert.match(programContent, /app\.MapGet\("\/api\/invoices", \(\) => Results\.Ok\(\)\);/);
  // Per-marker hash trailers: two distinct hashes proves content-based
  // idempotency scopes work across the two markers on the same file.
  const hashes = [...programContent.matchAll(/\/\/ scaffold-hash:([0-9a-f]{64})/g)].map((m) => m[1]);
  assert.equal(hashes.length, 2, `expected two distinct scaffold-hash trailers; got ${hashes.length}`);
  assert.notEqual(hashes[0], hashes[1], 'hash trailers for SCAFFOLD_DI and SCAFFOLD_ROUTES must differ');

  // Changeset + pending records were persisted. Read the change record off
  // disk so we can verify the report contents without depending on stdout
  // wire format. The changeset record follows the schema in
  // `packages/core/src/generate/changeManifest.ts`:
  //   { id, timestamp, entries: [{ file, kind, priorContent, writtenHash }, ...] }
  // AI_IMPLEMENTATION block info lives in the parallel pending file, not
  // inside the change entries.
  const changesDir = path.join(targetRepo, '.scaffold', 'changes');
  const pendingDir = path.join(targetRepo, '.scaffold', 'pending');
  assert.ok(existsSync(changesDir), 'changeset directory was not created');
  assert.ok(existsSync(pendingDir), 'pending directory was not created');
  const changesFiles = readdirSync(changesDir);
  assert.equal(changesFiles.length, 1, `expected exactly one changeset record; got ${JSON.stringify(changesFiles)}`);
  const changesRecord = JSON.parse(readFileSync(path.join(changesDir, changesFiles[0]), 'utf8'));
  const changesetId = changesFiles[0].replace(/\.json$/, '');
  assert.equal(changesRecord.id, changesetId, 'changeset record id must match its filename');
  assert.ok(changesRecord.timestamp, 'changeset record must carry an ISO timestamp');
  assert.equal(changesRecord.entries.length, 2, `expected two change entries (created endpoint + modified Program.cs); got ${JSON.stringify(changesRecord.entries.map((e) => e.file))}`);
  const createdEntries = changesRecord.entries.filter((e) => e.kind === 'created');
  const modifiedEntries = changesRecord.entries.filter((e) => e.kind === 'modified');
  assert.equal(createdEntries.length, 1, `expected exactly one created entry; got ${createdEntries.length}`);
  assert.equal(createdEntries[0].file, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.equal(createdEntries[0].priorContent, null, 'created entry must have null priorContent (no prior state)');
  assert.match(createdEntries[0].writtenHash, /^[0-9a-f]{64}$/);
  assert.equal(modifiedEntries.length, 1);
  assert.equal(modifiedEntries[0].file, 'Program.cs');
  assert.equal(typeof modifiedEntries[0].priorContent, 'string');
  assert.match(modifiedEntries[0].writtenHash, /^[0-9a-f]{64}$/);

  // AI_IMPLEMENTATION block info lives in the parallel pending file. The on-disk
  // schema (per packages/core/src/generate/pendingTracker.ts) is
  //   { changesetId, blocks: [{ file, startLine, endLine, placeholderContent }] }
  // — wrapped, NOT a flat array. (My earlier draft missed this and asserted
  // a flat-array shape; pendingTracker wraps it.)
  const pendingFiles = readdirSync(pendingDir);
  assert.equal(pendingFiles.length, 1, `expected exactly one pending record; got ${JSON.stringify(pendingFiles)}`);
  assert.equal(pendingFiles[0], changesFiles[0], 'pending record filename must match the change record filename');
  const pendingRecord = JSON.parse(readFileSync(path.join(pendingDir, pendingFiles[0]), 'utf8'));
  assert.equal(pendingRecord.changesetId, changesetId, 'pending record must carry the changeset id it was filed under');
  assert.equal(pendingRecord.blocks.length, 1, `pending record must list exactly one unfilled AI_IMPLEMENTATION block; got ${pendingRecord.blocks.length}`);
  assert.equal(pendingRecord.blocks[0].file, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.ok(
    pendingRecord.blocks[0].startLine >= 1 && pendingRecord.blocks[0].endLine > pendingRecord.blocks[0].startLine,
    'pending entry must carry a valid line range',
  );
  assert.ok(typeof pendingRecord.blocks[0].placeholderContent === 'string', 'pending entry must carry placeholderContent (the unfilled block body)');

  // Post-generate status: pending block means shim status exits 1.
  const statusBeforeFill = await execWrapper(SHIM_BIN, ['status', '--json'], { cwd: targetRepo, env });
  assert.equal(statusBeforeFill.status, 1, `expected shim status to exit 1 with pending AI_IMPLEMENTATION; got ${JSON.stringify(statusBeforeFill)}`);
  assert.equal(JSON.parse(statusBeforeFill.stdout).resolvedAll, false);

  // ---- recipe step 5: precheck refuses second generate ------------------------
  // Snapshot the endpoint file's mtime BEFORE the blocked call. The precheck's
  // whole point is to refuse before even invoking scaffold-core, so the
  // file's mtime must not move.
  const mtimeBeforeBlockedCall = statSync(endpointPath).mtimeMs;

  const gen2 = await execWrapper(SHIM_BIN, ['generate', '--manifest', manifestFile], { cwd: targetRepo, env });
  assert.equal(gen2.status, 1, `expected precheck-blocked generate to exit 1; got status=${gen2.status}; ${JSON.stringify(gen2)}`);
  // Non-json path: blocking refusal goes to stderr in human-readable form.
  assert.match(gen2.stderr, /refusing to generate/);
  assert.match(gen2.stderr, /InvoiceEndpoint\.cs/);
  assert.match(gen2.stderr, /Stop-hook guarantee/);
  assert.equal(mtimeBeforeBlockedCall, statSync(endpointPath).mtimeMs, 'precheck refusal must not have invoked scaffold generate (file mtime must be unchanged)');

  // Same call but with --json: blocking refusal should be a structured envelope
  // on stdout instead of free-text on stderr.
  const gen2Json = await execWrapper(SHIM_BIN, ['generate', '--manifest', manifestFile, '--json'], { cwd: targetRepo, env });
  assert.equal(gen2Json.status, 1, `expected precheck-blocked generate --json to exit 1; got status=${gen2Json.status}; ${JSON.stringify(gen2Json)}`);
  assert.match(gen2Json.stdout, /"error":\s*"precheck_blocked"/);
  assert.match(gen2Json.stdout, /"resolvedAll":\s*false/);

  // ---- recipe step 6: fill the AI_IMPLEMENTATION block -------------------------
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  assert.notEqual(filled, readFileSync(endpointPath, 'utf8'), 'the fill replace above must actually have matched something');
  writeFileSync(endpointPath, filled);

  const statusAfterFill = await execWrapper(SHIM_BIN, ['status', '--json'], { cwd: targetRepo, env });
  assert.equal(statusAfterFill.status, 0, `expected post-fill shim status to exit 0; got ${JSON.stringify(statusAfterFill)}`);
  assert.deepEqual(JSON.parse(statusAfterFill.stdout), { resolvedAll: true, unresolved: [] });

  // Regenerate now passes precheck and exits 0. Same --json shadow as gen1:
  // scaffold-core's success-path stdout is TOON, we only check exit + side
  // effects + that a new changeset was committed.
  const changesCountBeforeRegen = readdirSync(changesDir).length;
  const gen3 = await execWrapper(SHIM_BIN, ['generate', '--manifest', manifestFile], { cwd: targetRepo, env });
  assert.equal(gen3.status, 0, `expected post-fill generate to exit 0; got status=${gen3.status}; ${JSON.stringify(gen3)}`);
  assert.ok(gen3.stdout.length > 0, 'expected scaffold-core TOON report on stdout from post-fill regenerate');
  // Two-marker-per-file idempotency: a re-run with no host edits should NOT
  // produce a new changeset (per packages/core/test/integration/generate.test.ts
  // "running twice is idempotent"). The block fill is a host edit, but it
  // only affects the AI_IMPLEMENTATION block inside the endpoint file, not
  // the injected DI/route content, so SCAFFOLD_DI/SCAFFOLD_ROUTES still hash
  // the same → injected actions report 'unchanged' → no new changeset.
  assert.equal(readdirSync(changesDir).length, changesCountBeforeRegen, 're-run after AI_IMPLEMENTATION-only edit should not write a new changeset');
  assert.equal(readFileSync(programPath, 'utf8').length, programContent.length, 'Program.cs byte length must not change on a regeneration that touches only an AI_IMPLEMENTATION block (in another file)');
  assert.deepEqual(readFileSync(programPath, 'utf8'), programContent, 'Program.cs content must be byte-identical to the post-gen1 state');
});
