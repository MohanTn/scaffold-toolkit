#!/usr/bin/env node
/**
 * tools/check-guardrails.mjs
 * Proves the pack's edit-surface contract with the real CLI: after `scaffold
 * generate`, an LLM host is allowed to edit ONLY rule-body interiors
 * (AI_IMPLEMENTATION blocks in handlers, validators, domain entities) while
 * every wiring surface (Program.cs, DbContext, DI registrations) and every
 * pack-owned file write stays blocked by `scaffold check-edit` — the gate the
 * host adapters' PreToolUse hooks shell out to. validate-build.mjs proves the
 * output compiles; this proves the token-efficiency guardrails hold.
 *
 * Requires packages/core already built (dist/cli.js). No .NET SDK needed.
 */
'use strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORE_CLI = join(REPO_ROOT, 'packages', 'core', 'dist', 'cli.js');
const MANIFEST = join(REPO_ROOT, 'packages', 'templates-dotnet', 'test_data', 'domain-entity.json');
const PACK_SPEC = `backend=${REPO_ROOT}@packages/templates-dotnet/v8-controller`;

function run(args, cwd) {
  const result = spawnSync(process.execPath, [CORE_CLI, ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function runOrDie(label, args, cwd) {
  const result = run(args, cwd);
  if (result.status !== 0) {
    console.error(`\n--- ${label} failed ---\n${result.stdout}\n${result.stderr}`);
    process.exit(1);
  }
}

let failures = 0;

/** Assert a check-edit verdict: expectAllow maps to exit 0, block to exit 1. */
function expectVerdict(label, cwd, expectAllow, file, tool, oldString) {
  const args = ['check-edit', '--file', file, '--tool', tool];
  if (oldString !== undefined) args.push('--old-string', oldString);
  const result = run(args, cwd);
  const allowed = result.status === 0;
  if (allowed === expectAllow) {
    console.log(`  ok: ${label} → ${allowed ? 'allowed' : 'blocked'}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${label} — expected ${expectAllow ? 'allowed' : 'blocked'}, got ${allowed ? 'allowed' : 'blocked'}\n    ${result.stdout.trim()}`);
  }
}

function main() {
  if (!existsSync(CORE_CLI)) {
    console.error(`check-guardrails.mjs: ${CORE_CLI} not found — run "npm run build" (in packages/core) first`);
    process.exit(1);
  }

  const sampleDir = mkdtempSync(join(tmpdir(), 'scaffold-templates-dotnet-guardrails-'));
  try {
    runOrDie('scaffold init', ['init', '--project-type', 'dotnet', '--pack', PACK_SPEC], sampleDir);
    runOrDie('scaffold templates sync', ['templates', 'sync'], sampleDir);
    runOrDie('scaffold generate', ['generate', '--manifest', MANIFEST], sampleDir);

    const src = (rel) => readFileSync(join(sampleDir, rel), 'utf8');
    const entityFile = 'src/Company.MyProject.Domain/Entities/AlphaEntity.cs';
    const validatorFile = 'src/Company.MyProject.Application/Features/AlphaEntities/Commands/CreateAlphaEntity/CreateAlphaEntityCommandValidator.cs';
    const handlerFile = 'src/Company.MyProject.Application/Features/AlphaEntities/Commands/CreateAlphaEntity/CreateAlphaEntityCommandHandler.cs';
    const handlerTestFile = 'tests/Company.MyProject.Application.UnitTests/Features/AlphaEntities/CreateAlphaEntityCommandHandlerTests.cs';
    const validatorTestFile = 'tests/Company.MyProject.Application.UnitTests/Features/AlphaEntities/CreateAlphaEntityCommandValidatorTests.cs';

    console.log('\nWiring surfaces must stay frozen (suggestion 3):');
    expectVerdict('write Program.cs', sampleDir, false, 'src/Company.MyProject.Api/Program.cs', 'write');
    expectVerdict('edit Program.cs DI wiring', sampleDir, false, 'src/Company.MyProject.Api/Program.cs', 'edit', 'builder.Services.AddApplication();');
    expectVerdict('edit DbContext DbSet registration', sampleDir, false, 'src/Company.MyProject.Infrastructure/Persistence/ApplicationDbContext.cs', 'edit', 'DbSet<Company.MyProject.Domain.Entities.AlphaEntity>');
    expectVerdict('edit Infrastructure DI repository registration', sampleDir, false, 'src/Company.MyProject.Infrastructure/DependencyInjection.cs', 'edit', 'AddScoped<Company.MyProject.Application.Common.Interfaces.IAlphaEntityRepository');
    expectVerdict('write domain entity', sampleDir, false, entityFile, 'write');

    console.log('\nRule bodies must stay editable (suggestion 2):');
    expectVerdict('edit validator rule', sampleDir, true, validatorFile, 'edit', 'RuleFor(x => x.Name).NotEmpty();');
    expectVerdict('edit handler implementation', sampleDir, true, handlerFile, 'edit', 'await _repository.AddAsync(entity, cancellationToken);');
    expectVerdict('edit domain-behavior region', sampleDir, true, entityFile, 'edit', 'Domain behavior for AlphaEntity');
    expectVerdict('edit validator outside its region', sampleDir, false, validatorFile, 'edit', 'public class CreateAlphaEntityCommandValidator :');

    console.log('\nTest skeletons: arrange/act frozen, assertions editable (suggestion 4):');
    expectVerdict('edit handler-test assertion', sampleDir, true, handlerTestFile, 'edit', '_unitOfWork.Verify(u => u.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Once);');
    expectVerdict('edit handler-test arrange/act', sampleDir, false, handlerTestFile, 'edit', 'var result = await handler.Handle(command, CancellationToken.None);');
    expectVerdict('edit validator-test assertion', sampleDir, true, validatorTestFile, 'edit', 'result.ShouldHaveValidationErrorFor(x => x.Name);');

    // Guard the assertions themselves: every old_string above must actually
    // exist in the generated output, or a template rename would turn a real
    // regression into a vacuous "blocked because not found".
    for (const [rel, needle] of [
      [validatorFile, 'RuleFor(x => x.Name).NotEmpty();'],
      [entityFile, 'Domain behavior for AlphaEntity'],
      [handlerFile, 'await _repository.AddAsync(entity, cancellationToken);'],
      [handlerTestFile, '_unitOfWork.Verify(u => u.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Once);'],
      [validatorTestFile, 'result.ShouldHaveValidationErrorFor(x => x.Name);'],
    ]) {
      if (!src(rel).includes(needle)) {
        failures += 1;
        console.error(`  FAIL: expected "${needle}" in generated ${rel}`);
      }
    }
  } finally {
    rmSync(sampleDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\ncheck-guardrails.mjs: FAILED — ${failures} assertion(s) did not hold`);
    process.exit(1);
  }
  console.log('\ncheck-guardrails.mjs: OK — wiring frozen, rule bodies editable.');
}

main();
