/**
 * Tests for `gh scaffold install-hooks` (src/installHooks.mjs).
 *
 * Unit-level: buildHooksConfig/resolveHookScriptPaths as pure(ish) functions.
 * Integration-level: actually run `dispatch(['install-hooks', ...])` against
 * a scratch repo, read the written config back, then spawn the two hook
 * scripts it points at with synthetic Copilot-shaped stdin against a real
 * fixture target repo (built the same way end-to-end.test.mjs does) to prove
 * the whole chain — install, then nudge-while-pending, then allow-once-filled
 * — actually works, not just that a JSON file gets written.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatch } from '../src/index.mjs';
import { resolveHookScriptPaths, buildHooksConfig, installHooks } from '../src/installHooks.mjs';
import {
  SCAFFOLD_CLI,
  setupScaffoldOnPath,
  buildFixturePackRepo,
  buildFixtureTargetRepo,
  writeManifestFile,
  execWrapper,
} from './_harness.mjs';

// ---------- unit-level: pure config shape ----------------------------------

test('resolveHookScriptPaths returns paths to real files shipped in this package', () => {
  const paths = resolveHookScriptPaths();
  assert.ok(existsSync(paths.postToolUse), `expected ${paths.postToolUse} to exist`);
  assert.ok(existsSync(paths.agentStop), `expected ${paths.agentStop} to exist`);
});

test('buildHooksConfig matches the Copilot CLI hooks-reference schema (version 1, postToolUse + agentStop command hooks)', () => {
  const config = buildHooksConfig({ postToolUse: '/abs/post-tool-use.mjs', agentStop: '/abs/agent-stop.mjs' });
  assert.equal(config.version, 1);
  assert.equal(config.hooks.postToolUse[0].type, 'command');
  assert.match(config.hooks.postToolUse[0].bash, /post-tool-use\.mjs/);
  assert.equal(config.hooks.agentStop[0].type, 'command');
  assert.match(config.hooks.agentStop[0].bash, /agent-stop\.mjs/);
});

test('installHooks writes .github/hooks/scaffold-toolkit.json with absolute script paths', () => {
  const targetRepo = mkdtempSync(path.join(tmpdir(), 'scaffold-hooks-target-'));
  const configPath = installHooks(targetRepo);
  assert.equal(configPath, path.join(targetRepo, '.github', 'hooks', 'scaffold-toolkit.json'));
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(written.version, 1);
  assert.ok(path.isAbsolute(written.hooks.postToolUse[0].bash.match(/"([^"]+)"/)[1]));
});

test('dispatch: install-hooks writes the config and reports its path', async () => {
  const targetRepo = mkdtempSync(path.join(tmpdir(), 'scaffold-hooks-target-'));
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let code;
  try {
    code = await dispatch(['install-hooks', '--cwd', targetRepo]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(code, 0);
  assert.match(chunks.join(''), /scaffold-toolkit\.json/);
  assert.ok(existsSync(path.join(targetRepo, '.github', 'hooks', 'scaffold-toolkit.json')));
});

// ---------- integration-level: drive the installed hooks for real ----------

let envFactory;
before(() => {
  assert.ok(existsSync(SCAFFOLD_CLI), `scaffold-core dist not built — run \`npm run build\` first (expected ${SCAFFOLD_CLI})`);
  const setup = setupScaffoldOnPath(SCAFFOLD_CLI);
  envFactory = setup.childEnv;
});

/** Spawns `node <scriptPath>` feeding `stdinObj` as JSON on stdin, in `cwd`/`env`. Returns parsed stdout JSON. */
function runHookScript(scriptPath, stdinObj, { cwd, env }) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    env,
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `hook script exited non-zero: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('install-hooks end to end: postToolUse nudges while pending, agentStop blocks then allows once filled', async () => {
  const env = envFactory();
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();

  await execWrapper(SCAFFOLD_CLI, ['init', '--project-type', 'dotnet', '--pack', `backend=${packRepo}@v1`], { cwd: targetRepo, env });
  await execWrapper(SCAFFOLD_CLI, ['templates', 'sync'], { cwd: targetRepo, env });

  const configPath = installHooks(targetRepo);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const postToolUsePath = config.hooks.postToolUse[0].bash.match(/"([^"]+)"/)[1];
  const agentStopPath = config.hooks.agentStop[0].bash.match(/"([^"]+)"/)[1];

  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const gen = await execWrapper(SCAFFOLD_CLI, ['generate', '--manifest', manifestFile], { cwd: targetRepo, env });
  assert.equal(gen.status, 0, `generate failed: ${JSON.stringify(gen)}`);

  // postToolUse: a bash tool call that ran `scaffold generate` should nudge, since a block is still pending.
  const postToolUseInput = {
    toolName: 'bash',
    toolArgs: { command: `npx -y @mohantn/scaffold-core generate --manifest ${manifestFile}` },
    cwd: targetRepo,
  };
  const nudge = runHookScript(postToolUsePath, postToolUseInput, { cwd: targetRepo, env });
  assert.match(nudge.additionalContext, /InvoiceEndpoint\.cs/);

  // A bash call unrelated to scaffold generate must stay a silent no-op.
  const noOp = runHookScript(postToolUsePath, { toolName: 'bash', toolArgs: { command: 'npm test' }, cwd: targetRepo }, { cwd: targetRepo, env });
  assert.deepEqual(noOp, {});

  // agentStop: must block while the block is pending.
  const blocked = runHookScript(agentStopPath, { cwd: targetRepo }, { cwd: targetRepo, env });
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /InvoiceEndpoint\.cs/);

  // Fill the block by hand, exactly like the host agent's edit step.
  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  writeFileSync(endpointPath, filled);

  // agentStop must now allow the stop.
  const allowed = runHookScript(agentStopPath, { cwd: targetRepo }, { cwd: targetRepo, env });
  assert.deepEqual(allowed, { decision: 'allow' });

  // postToolUse must now be a silent no-op even for a real generate command, since nothing is pending.
  const resolvedNoNudge = runHookScript(postToolUsePath, postToolUseInput, { cwd: targetRepo, env });
  assert.deepEqual(resolvedNoNudge, {});
});
