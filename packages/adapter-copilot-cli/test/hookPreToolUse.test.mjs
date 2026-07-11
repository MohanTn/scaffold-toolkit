/**
 * Tests for hooks/pre-tool-use.mjs.
 *
 * IMPORTANT — same caveat as the hook script's own header comment: the
 * `toolName`/`toolArgs` shape these tests assume for a Copilot CLI file
 * write/edit (`'write'`/`'edit'` toolNames, `toolArgs.path`,
 * `toolArgs.oldString`) is an unverified guess, not a confirmed payload.
 * These tests prove the hook's *logic* is internally consistent given that
 * assumed shape; they do NOT prove the assumed shape is correct. Once a
 * real Copilot CLI preToolUse payload has been captured (per the plan's
 * open question), revise both the hook script and this file's fixtures to
 * match reality — do not treat a green run here as field-shape validation.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shouldCheckEdit, extractEditRequest, buildDecision, shouldUseOldStringFile } from '../hooks/pre-tool-use.mjs';
import {
  SCAFFOLD_CLI,
  setupScaffoldOnPath,
  buildFixturePackRepo,
  buildFixtureTargetRepo,
  writeManifestFile,
  execWrapper,
} from './_harness.mjs';

// ---------- unit-level: pure decision functions (against the guessed shape) -

test('shouldCheckEdit is true for the guessed write/edit toolNames, false otherwise', () => {
  assert.equal(shouldCheckEdit({ toolName: 'write', toolArgs: {} }), true);
  assert.equal(shouldCheckEdit({ toolName: 'edit', toolArgs: {} }), true);
  assert.equal(shouldCheckEdit({ toolName: 'bash', toolArgs: { command: 'ls' } }), false);
  assert.equal(shouldCheckEdit(undefined), false);
  assert.equal(shouldCheckEdit({}), false);
});

test('extractEditRequest builds a write request from the guessed toolArgs.path field', () => {
  const request = extractEditRequest({ toolName: 'write', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'x' } });
  assert.deepEqual(request, { file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'write' });
});

test('extractEditRequest builds an edit request carrying the guessed toolArgs.oldString field', () => {
  const request = extractEditRequest({ toolName: 'edit', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', oldString: 'foo', newString: 'bar' } });
  assert.deepEqual(request, { file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'edit', oldString: 'foo' });
});

test('extractEditRequest tolerates toolArgs delivered as a JSON-encoded string (same ambiguity post-tool-use.mjs already handles for bash)', () => {
  const request = extractEditRequest({ toolName: 'write', toolArgs: JSON.stringify({ path: 'x.cs', content: 'y' }) });
  assert.deepEqual(request, { file: 'x.cs', tool: 'write' });
});

test('extractEditRequest returns undefined when the path field is missing or malformed', () => {
  assert.equal(extractEditRequest({ toolName: 'write', toolArgs: {} }), undefined);
  assert.equal(extractEditRequest({ toolName: 'write', toolArgs: { path: 42 } }), undefined);
  assert.equal(extractEditRequest({ toolName: 'write', toolArgs: 'not json' }), undefined);
});

test('buildDecision returns an explicit permissionDecision: "allow" when check-edit allows (Copilot documents decision as required, no implicit default)', () => {
  assert.deepEqual(buildDecision(0, JSON.stringify({ allow: true, reason: 'not-pack-owned', detail: 'x', packOwned: false })), { permissionDecision: 'allow' });
});

test('buildDecision denies with permissionDecisionReason when check-edit blocks', () => {
  const decision = buildDecision(1, JSON.stringify({ allow: false, reason: 'write-blocked', detail: 'go run scaffold generate', packOwned: true, packSlot: 'backend' }));
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /go run scaffold generate/);
});

test('buildDecision fails closed (deny) when check-edit stdout is not parseable JSON', () => {
  const decision = buildDecision(127, 'scaffold: command not found');
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /command not found/);
});

test('shouldUseOldStringFile is false for a short old_string (the direct --old-string argv path)', () => {
  assert.equal(shouldUseOldStringFile('Console.WriteLine("handled");'), false);
  assert.equal(shouldUseOldStringFile('x'.repeat(8000)), false, 'exactly at the threshold must still use the direct-arg path');
});

test('shouldUseOldStringFile is true once old_string exceeds the threshold (the --old-string-file fallback path)', () => {
  assert.equal(shouldUseOldStringFile('x'.repeat(8001)), true);
});

test('shouldUseOldStringFile is false for undefined or non-string input', () => {
  assert.equal(shouldUseOldStringFile(undefined), false);
  assert.equal(shouldUseOldStringFile(42), false);
});

// ---------- integration-level: drive the real script against a real repo ---

let envFactory;
before(() => {
  assert.ok(existsSync(SCAFFOLD_CLI), `scaffold-core dist not built — run \`npm run build\` first (expected ${SCAFFOLD_CLI})`);
  const setup = setupScaffoldOnPath(SCAFFOLD_CLI);
  envFactory = setup.childEnv;
});

const PRE_TOOL_USE_SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'hooks', 'pre-tool-use.mjs');

function runHookScript(scriptPath, stdinObj, { cwd, env }) {
  const result = spawnSync(process.execPath, [scriptPath], { cwd, env, input: JSON.stringify(stdinObj), encoding: 'utf8' });
  assert.equal(result.status, 0, `hook script exited non-zero: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('pre-tool-use.mjs end to end (against the guessed payload shape): blocks a raw write to a pack-owned target, allows an in-interior edit once generated', async () => {
  const env = envFactory();
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();

  await execWrapper(SCAFFOLD_CLI, ['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], { cwd: targetRepo, env });
  await execWrapper(SCAFFOLD_CLI, ['templates', 'sync'], { cwd: targetRepo, env });

  const blockedWrite = runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'write', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'public class InvoiceEndpoint {}' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(blockedWrite.permissionDecision, 'deny');
  assert.match(blockedWrite.permissionDecisionReason, /scaffold generate/);

  const unrelatedWrite = runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'write', toolArgs: { path: 'README.md', content: '# hi' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(unrelatedWrite.permissionDecision, 'allow');

  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const gen = await execWrapper(SCAFFOLD_CLI, ['generate', '--manifest', manifestFile], { cwd: targetRepo, env });
  assert.equal(gen.status, 0, `generate failed: ${JSON.stringify(gen)}`);

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  writeFileSync(endpointPath, filled);

  const allowedEdit = runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'edit', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', oldString: 'Console.WriteLine("handled");', newString: 'X' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(allowedEdit.permissionDecision, 'allow');
});

test('pre-tool-use.mjs routes an old_string over the size threshold through --old-string-file instead of a literal argv element, without crashing', async () => {
  const env = envFactory();
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();

  await execWrapper(SCAFFOLD_CLI, ['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], { cwd: targetRepo, env });
  await execWrapper(SCAFFOLD_CLI, ['templates', 'sync'], { cwd: targetRepo, env });
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const gen = await execWrapper(SCAFFOLD_CLI, ['generate', '--manifest', manifestFile], { cwd: targetRepo, env });
  assert.equal(gen.status, 0, `generate failed: ${JSON.stringify(gen)}`);

  // Exceeds OLD_STRING_ARG_THRESHOLD, forcing runCheckEdit's temp-file
  // fallback. It doesn't actually appear anywhere in the file, so
  // check-edit legitimately blocks it as "not found" — the point of this
  // test is that the hook reaches that real verdict via a real `scaffold`
  // subprocess spawn at all, rather than execFileSync failing to spawn.
  const hugeOldString = 'x'.repeat(20000);
  const decision = runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'edit', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', oldString: hugeOldString, newString: 'y' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /not found|refusing to guess/);
});
