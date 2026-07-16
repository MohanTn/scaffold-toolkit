import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('shouldCheckEdit is true for Write and Edit, false for everything else', () => {
  assert.equal(shouldCheckEdit({ tool_name: 'Write', tool_input: {} }), true);
  assert.equal(shouldCheckEdit({ tool_name: 'Edit', tool_input: {} }), true);
  assert.equal(shouldCheckEdit({ tool_name: 'Bash', tool_input: { command: 'ls' } }), false);
  assert.equal(shouldCheckEdit({ tool_name: 'Read', tool_input: {} }), false);
  assert.equal(shouldCheckEdit(undefined), false);
  assert.equal(shouldCheckEdit({}), false);
});

test('extractEditRequest builds a write request from a Write tool call, ignoring old_string entirely', () => {
  const request = extractEditRequest({ tool_name: 'Write', tool_input: { file_path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'whatever' } });
  assert.deepEqual(request, { file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'write' });
});

test('extractEditRequest builds an edit request carrying old_string from an Edit tool call', () => {
  const request = extractEditRequest({
    tool_name: 'Edit',
    tool_input: { file_path: 'src/Endpoints/InvoiceEndpoint.cs', old_string: 'foo', new_string: 'bar' },
  });
  assert.deepEqual(request, { file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'edit', oldString: 'foo' });
});

test('extractEditRequest returns undefined when file_path is missing or not a string', () => {
  assert.equal(extractEditRequest({ tool_name: 'Write', tool_input: {} }), undefined);
  assert.equal(extractEditRequest({ tool_name: 'Write', tool_input: { file_path: 42 } }), undefined);
});

test('extractEditRequest passes old_string through as undefined (not skipped) when an Edit call is missing it', () => {
  const request = extractEditRequest({ tool_name: 'Edit', tool_input: { file_path: 'x.cs' } });
  assert.deepEqual(request, { file: 'x.cs', tool: 'edit', oldString: undefined });
});

test('buildDecision returns an empty object (default permission flow) when check-edit allows', () => {
  assert.deepEqual(buildDecision(0, JSON.stringify({ allow: true, reason: 'not-pack-owned', detail: 'x', packOwned: false })), {});
});

test('buildDecision denies via hookSpecificOutput.permissionDecision when check-edit blocks', () => {
  const decision = buildDecision(1, JSON.stringify({ allow: false, reason: 'write-blocked', detail: 'go run scaffold generate', packOwned: true, packSlot: 'backend' }));
  assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /go run scaffold generate/);
});

test('buildDecision fails closed (deny) when check-edit stdout is not parseable JSON, e.g. the binary crashed', () => {
  const decision = buildDecision(127, 'scaffold: command not found');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /command not found/);
});

test('buildDecision in "nudge" mode surfaces a check-edit denial as additionalContext instead of blocking', () => {
  const decision = buildDecision(
    1,
    JSON.stringify({ allow: false, reason: 'write-blocked', detail: 'go run scaffold generate', packOwned: true, packSlot: 'backend' }),
    null,
    'nudge',
  );
  assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(decision.hookSpecificOutput.permissionDecision, undefined, 'nudge mode must never set permissionDecision');
  assert.match(decision.hookSpecificOutput.additionalContext, /go run scaffold generate/);
});

test('buildDecision in "nudge" mode surfaces an unparseable check-edit result as additionalContext instead of blocking', () => {
  const decision = buildDecision(127, 'scaffold: command not found', null, 'nudge');
  assert.equal(decision.hookSpecificOutput.permissionDecision, undefined);
  assert.match(decision.hookSpecificOutput.additionalContext, /command not found/);
});

test('buildDecision in "nudge" mode leaves an allow untouched (still empty decision, still injects standards guidance)', () => {
  assert.deepEqual(buildDecision(0, JSON.stringify({ allow: true }), null, 'nudge'), {});
  const decision = buildDecision(0, JSON.stringify({ allow: true }), 'some guidance', 'nudge');
  assert.equal(decision.hookSpecificOutput.additionalContext, 'some guidance');
});

test('buildDecision defaults to "gate" when mode is omitted (backward compatible)', () => {
  const decision = buildDecision(1, JSON.stringify({ allow: false, detail: 'x' }));
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
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
    { tool_name: 'Write', tool_input: { file_path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'x' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('pre-tool-use.mjs end to end: blocks a raw Write to a pack-owned target, then allows an Edit inside the AI_IMPLEMENTATION interior once generated', async () => {
  const env = envFactory();
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();

  await execWrapper(SCAFFOLD_CLI, ['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], { cwd: targetRepo, env });
  await execWrapper(SCAFFOLD_CLI, ['templates', 'sync'], { cwd: targetRepo, env });

  // A raw Write to the unrendered pack-owned target must be blocked.
  const blockedWrite = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { tool_name: 'Write', tool_input: { file_path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'public class InvoiceEndpoint {}' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(blockedWrite.status, 0, 'the hook script itself always exits 0; the block is expressed in its JSON output');
  const blockedDecision = JSON.parse(blockedWrite.stdout);
  assert.equal(blockedDecision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(blockedDecision.hookSpecificOutput.permissionDecisionReason, /scaffold generate/);

  // A Write to a file no pack owns must stay a silent no-op.
  const unrelatedWrite = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { tool_name: 'Write', tool_input: { file_path: 'README.md', content: '# hi' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.deepEqual(JSON.parse(unrelatedWrite.stdout), {});

  // Run the real generate.
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const gen = await execWrapper(SCAFFOLD_CLI, ['generate', '--manifest', manifestFile], { cwd: targetRepo, env });
  assert.equal(gen.status, 0, `generate failed: ${JSON.stringify(gen)}`);

  // Fill the AI_IMPLEMENTATION block by hand (simulating a first pass), then
  // propose a follow-up Edit whose old_string lands entirely inside the
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
      tool_name: 'Edit',
      tool_input: { file_path: 'src/Endpoints/InvoiceEndpoint.cs', old_string: 'Console.WriteLine("handled");', new_string: 'Console.WriteLine("handled differently");' },
      cwd: targetRepo,
    },
    { cwd: targetRepo, env },
  );
  assert.deepEqual(JSON.parse(allowedEdit.stdout), {}, 'an edit inside the AI_IMPLEMENTATION interior must be allowed (empty decision = default permission flow)');

  // An Edit targeting the injected SCAFFOLD_DI region must be blocked.
  const programContent = readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8');
  const diLine = programContent.split('\n').find((l) => l.includes('AddScoped<IInvoiceService'));
  assert.ok(diLine, 'expected the injected DI registration line to be present');

  const blockedEdit = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { tool_name: 'Edit', tool_input: { file_path: 'Program.cs', old_string: diLine, new_string: 'X' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  const blockedEditDecision = JSON.parse(blockedEdit.stdout);
  assert.equal(blockedEditDecision.hookSpecificOutput.permissionDecision, 'deny');
});

test('pre-tool-use.mjs end to end: a repo with .scaffold/conf.json editEnforcement "nudge" surfaces a would-be-blocked write as additionalContext and lets it proceed', async () => {
  const env = envFactory();
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();

  await execWrapper(SCAFFOLD_CLI, ['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], { cwd: targetRepo, env });
  await execWrapper(SCAFFOLD_CLI, ['templates', 'sync'], { cwd: targetRepo, env });
  mkdirSync(path.join(targetRepo, '.scaffold'), { recursive: true });
  writeFileSync(path.join(targetRepo, '.scaffold', 'conf.json'), JSON.stringify({ editEnforcement: 'nudge' }));

  const result = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { tool_name: 'Write', tool_input: { file_path: 'src/Endpoints/InvoiceEndpoint.cs', content: 'public class InvoiceEndpoint {}' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.hookSpecificOutput.permissionDecision, undefined, 'nudge mode must not block the write');
  assert.match(decision.hookSpecificOutput.additionalContext, /scaffold generate/);
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
  // subprocess spawn at all, rather than execFileSync failing to spawn (or
  // the fallback's temp file being mishandled).
  const hugeOldString = 'x'.repeat(20000);
  const result = await runHookScript(
    PRE_TOOL_USE_SCRIPT,
    { tool_name: 'Edit', tool_input: { file_path: 'src/Endpoints/InvoiceEndpoint.cs', old_string: hugeOldString, new_string: 'y' }, cwd: targetRepo },
    { cwd: targetRepo, env },
  );
  assert.equal(result.status, 0, 'the hook script itself must not crash even though old_string exceeds the argv-safe threshold');
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /not found|refusing to guess/);
});
