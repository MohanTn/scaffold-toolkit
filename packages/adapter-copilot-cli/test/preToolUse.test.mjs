/**
 * Tests for hooks/pre-tool-use.mjs.
 *
 * The toolName values (`create`/`edit`/`str_replace_editor`/`apply_patch`)
 * are doc-confirmed against the Copilot hooks reference; the field names
 * inside `toolArgs` are not documented, so the fixtures here use the
 * primary guessed shape (`path`/`oldString`) the hook tolerates alongside
 * its snake_case fallbacks. These tests prove the hook's logic is
 * internally consistent given that shape; capturing a real Copilot CLI
 * preToolUse payload remains the definitive field-shape validation.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
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
  runHookScript,
} from './_harness.mjs';

// ---------- unit-level: pure decision functions -----------------------------

test('shouldCheckEdit is true for the doc-confirmed create/edit toolNames, false for everything else', () => {
  assert.equal(shouldCheckEdit({ toolName: 'create', toolArgs: {} }), true);
  assert.equal(shouldCheckEdit({ toolName: 'edit', toolArgs: {} }), true);
  assert.equal(shouldCheckEdit({ toolName: 'str_replace_editor', toolArgs: {} }), true);
  assert.equal(shouldCheckEdit({ toolName: 'apply_patch', toolArgs: {} }), true);
  assert.equal(shouldCheckEdit({ toolName: 'bash', toolArgs: { command: 'ls' } }), false);
  assert.equal(shouldCheckEdit({ toolName: 'view', toolArgs: {} }), false);
  assert.equal(shouldCheckEdit(undefined), false);
  assert.equal(shouldCheckEdit({}), false);
});

test('extractEditRequest builds a write request from a create tool call, ignoring oldString entirely', () => {
  const request = extractEditRequest({ toolName: 'create', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'whatever' } });
  assert.deepEqual(request, { file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'write' });
});

test('extractEditRequest builds an edit request carrying oldString from an edit tool call', () => {
  const request = extractEditRequest({
    toolName: 'edit',
    toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', oldString: 'foo', newString: 'bar' },
  });
  assert.deepEqual(request, { file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'edit', oldString: 'foo' });
});

test('extractEditRequest tolerates the snake_case fallback field names', () => {
  const request = extractEditRequest({
    toolName: 'str_replace_editor',
    toolArgs: { file_path: 'x.cs', old_str: 'foo' },
  });
  assert.deepEqual(request, { file: 'x.cs', tool: 'edit', oldString: 'foo' });
});

test('extractEditRequest tolerates toolArgs delivered as a JSON-encoded string (same ambiguity post-tool-use.mjs handles for bash)', () => {
  const request = extractEditRequest({ toolName: 'create', toolArgs: JSON.stringify({ path: 'x.cs', content: 'y' }) });
  assert.deepEqual(request, { file: 'x.cs', tool: 'write' });
});

test('extractEditRequest returns undefined when the file path is missing or malformed', () => {
  assert.equal(extractEditRequest({ toolName: 'create', toolArgs: {} }), undefined);
  assert.equal(extractEditRequest({ toolName: 'create', toolArgs: { path: 42 } }), undefined);
  assert.equal(extractEditRequest({ toolName: 'create', toolArgs: 'not json' }), undefined);
});

test('extractEditRequest passes oldString through as undefined (not skipped) when an edit call is missing it', () => {
  const request = extractEditRequest({ toolName: 'apply_patch', toolArgs: { path: 'x.cs', patch: '...' } });
  assert.deepEqual(request, { file: 'x.cs', tool: 'edit', oldString: undefined });
});

test('buildDecision returns an empty object (default permission flow) when check-edit allows', () => {
  assert.deepEqual(buildDecision(0, JSON.stringify({ allow: true, reason: 'not-pack-owned', detail: 'x', packOwned: false })), {});
});

test('buildDecision denies via the flat permissionDecision field when check-edit blocks', () => {
  const decision = buildDecision(1, JSON.stringify({ allow: false, reason: 'write-blocked', detail: 'go run scaffold generate', packOwned: true, packSlot: 'backend' }));
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /go run scaffold generate/);
  assert.equal(Object.prototype.hasOwnProperty.call(decision, 'hookSpecificOutput'), false, "Copilot preToolUse output is flat, unlike Claude Code's nested hookSpecificOutput shape");
});

test('buildDecision fails closed (deny) when check-edit stdout is not parseable JSON, e.g. the binary crashed', () => {
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

test('pre-tool-use.mjs is a silent no-op in a repo with no .scaffold/config.json', async () => {
  const env = envFactory();
  const targetRepo = buildFixtureTargetRepo();
  const result = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'create', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'x' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('pre-tool-use.mjs end to end: blocks a raw create of a pack-owned target, then allows an edit inside the AI_IMPLEMENTATION interior once generated', async () => {
  const env = envFactory();
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();

  await execWrapper(SCAFFOLD_CLI, ['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], { cwd: targetRepo, env });
  await execWrapper(SCAFFOLD_CLI, ['templates', 'sync'], { cwd: targetRepo, env });

  // A raw create of the unrendered pack-owned target must be blocked.
  const blockedWrite = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'create', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'public class InvoiceEndpoint {}' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(blockedWrite.status, 0, 'the hook script itself always exits 0; the block is expressed in its JSON output');
  const blockedDecision = JSON.parse(blockedWrite.stdout);
  assert.equal(blockedDecision.permissionDecision, 'deny');
  assert.match(blockedDecision.permissionDecisionReason, /scaffold generate/);

  // A create of a file no pack owns must stay a silent no-op (default flow).
  const unrelatedWrite = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'create', toolArgs: { path: 'README.md', content: '# hi' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.deepEqual(JSON.parse(unrelatedWrite.stdout), {});

  // Run the real generate.
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const gen = await execWrapper(SCAFFOLD_CLI, ['generate', '--manifest', manifestFile], { cwd: targetRepo, env });
  assert.equal(gen.status, 0, `generate failed: ${JSON.stringify(gen)}`);

  // Fill the AI_IMPLEMENTATION block by hand (simulating a first pass), then
  // propose a follow-up edit whose oldString lands entirely inside the
  // interior — must be allowed.
  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  writeFileSync(endpointPath, filled);

  const allowedEdit = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    {
      toolName: 'edit',
      toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', oldString: 'Console.WriteLine("handled");', newString: 'Console.WriteLine("handled differently");' },
      cwd: targetRepo,
    },
    { cwd: targetRepo, env },
  );
  assert.deepEqual(JSON.parse(allowedEdit.stdout), {}, 'an edit inside the AI_IMPLEMENTATION interior must be allowed (empty decision = default permission flow)');

  // An edit targeting the injected SCAFFOLD_DI region must be blocked.
  const programContent = readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8');
  const diLine = programContent.split('\n').find((l) => l.includes('AddScoped<IInvoiceService'));
  assert.ok(diLine, 'expected the injected DI registration line to be present');

  const blockedEdit = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'edit', toolArgs: { path: 'Program.cs', oldString: diLine, newString: 'X' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  const blockedEditDecision = JSON.parse(blockedEdit.stdout);
  assert.equal(blockedEditDecision.permissionDecision, 'deny');
});

test('pre-tool-use.mjs routes an oldString over the size threshold through --old-string-file instead of a literal argv element, without crashing', async () => {
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
  // subprocess spawn at all, rather than execFileSync failing to spawn (or
  // the fallback's temp file being mishandled).
  const hugeOldString = 'x'.repeat(20000);
  const result = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { toolName: 'edit', toolArgs: { path: 'src/Endpoints/InvoiceEndpoint.cs', oldString: hugeOldString, newString: 'y' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(result.status, 0, 'the hook script itself must not crash even though oldString exceeds the argv-safe threshold');
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /not found|refusing to guess/);
});
