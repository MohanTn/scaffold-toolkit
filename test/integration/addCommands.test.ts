/**
 * End-to-end coverage of the `scaffold add` family against a fixture pack
 * shaped like csharp-enterprise: op-tagged CRUD targets, a when-gated
 * split/combined repository layout carrying REPO_INTERFACE_METHODS /
 * REPO_IMPL_METHODS zones, a controller with a CONTROLLER_ACTIONS zone, and
 * `custom-endpoint` injections extending both. Compilers run in-process into
 * `runGenerate` (same path the CLI actions take); one CLI-level smoke proves
 * the command wiring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGenerate } from '../../src/generate/generate.js';
import { saveConfig } from '../../src/config/loader.js';
import { compileAddFeature } from '../../src/add/addFeature.js';
import { compileAddCustom } from '../../src/add/addCustom.js';
import { compileAddArtifact } from '../../src/add/addArtifact.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAFFOLD_CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

const CONTROLLER_TEMPLATE = `namespace Fixture.Controllers;

public class {{entity}}sController
{
    // SCAFFOLD:CONTROLLER_ACTIONS:START
    // SCAFFOLD:CONTROLLER_ACTIONS:END
}
`;

const REPO_INTERFACE_TEMPLATE = `namespace Fixture.Repositories;

public interface I{{entity}}Repository
{
    // SCAFFOLD:REPO_INTERFACE_METHODS:START
    // SCAFFOLD:REPO_INTERFACE_METHODS:END
}
`;

const REPO_IMPL_TEMPLATE = `namespace Fixture.Repositories;

public class {{entity}}Repository : I{{entity}}Repository
{
    // SCAFFOLD:REPO_IMPL_METHODS:START
    // SCAFFOLD:REPO_IMPL_METHODS:END
}
`;

const REPO_COMBINED_TEMPLATE = `namespace Fixture.Repositories;

public interface I{{entity}}Repository
{
    // SCAFFOLD:REPO_INTERFACE_METHODS:START
    // SCAFFOLD:REPO_INTERFACE_METHODS:END
}

public class {{entity}}Repository : I{{entity}}Repository
{
    // SCAFFOLD:REPO_IMPL_METHODS:START
    // SCAFFOLD:REPO_IMPL_METHODS:END
}
`;

const CREATE_COMMAND_TEMPLATE = `namespace Fixture.Commands;

public class Create{{entity}}Command
{
    public void Handle()
    {
        // SCAFFOLD:AI_IMPLEMENTATION:START:required
        // SCAFFOLD:AI_IMPLEMENTATION:END
    }
}
`;

const READ_QUERY_TEMPLATE = `namespace Fixture.Queries;\n\npublic class Get{{entity}}Query { }\n`;

const CUSTOM_HANDLER_TEMPLATE = `namespace Fixture.Queries;

public class {{methodName}}Handler
{
    public {{returnType}} Handle()
    {
        // SCAFFOLD:AI_IMPLEMENTATION:START:required
        // SCAFFOLD:AI_IMPLEMENTATION:END
    }
}
`;

const DOMAIN_EVENT_TEMPLATE = `namespace Fixture.Events;\n\npublic record {{eventName}}Event();\n`;

const CONTROLLER_ACTION_SNIPPET = `    public {{returnType}} {{methodName}}() => _sender.Send(new {{methodName}}Query());`;
const REPO_INTERFACE_METHOD_SNIPPET = `    {{returnType}} {{methodName}}Async();`;
const REPO_IMPL_METHOD_SNIPPET = `    public {{returnType}} {{methodName}}Async() => throw new NotImplementedException();`;

function buildEnterpriseFixturePack(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-add-pack-'));
  const versionDir = path.join(dir, 'v9');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify(
      {
        descriptorSchemaVersion: 2,
        packVersion: 'v9',
        requires: { scaffoldCli: '>=0.0.0' },
        // Declaring inputs[] opts out of the legacy entity+fields contract:
        // artifact-scoped manifests (domain-event, custom) don't carry fields.
        inputs: [
          { name: 'artifacts', type: 'array', required: true, minItems: 1 },
          { name: 'entity', type: 'string', required: false, pattern: '^[A-Z][A-Za-z0-9]*$' },
        ],
        targets: [
          { output: 'src/Controllers/{{entity}}sController.cs', template: 'Controller.cs.hbs', mode: 'skip-if-exists' },
          { output: 'src/Commands/Create{{entity}}Command.cs', template: 'CreateCommand.cs.hbs', mode: 'create', artifact: 'op-create' },
          { output: 'src/Queries/Get{{entity}}Query.cs', template: 'ReadQuery.cs.hbs', mode: 'create', artifact: 'op-read' },
          {
            output: 'src/Repositories/I{{entity}}Repository.cs',
            template: 'RepoInterface.cs.hbs',
            mode: 'skip-if-exists',
            when: { 'options.combine': false },
          },
          {
            output: 'src/Repositories/{{entity}}Repository.cs',
            template: 'RepoImpl.cs.hbs',
            mode: 'skip-if-exists',
            when: { 'options.combine': false },
          },
          {
            output: 'src/Repositories/{{entity}}Repository.cs',
            template: 'RepoCombined.cs.hbs',
            mode: 'skip-if-exists',
            when: { 'options.combine': true },
          },
          { output: 'src/Queries/{{methodName}}Handler.cs', template: 'CustomHandler.cs.hbs', mode: 'create', artifact: 'custom-endpoint' },
          { output: 'src/Events/{{eventName}}Event.cs', template: 'DomainEvent.cs.hbs', mode: 'create', artifact: 'domain-event' },
        ],
        injections: [
          {
            file: 'src/Controllers/{{targetController}}.cs',
            marker: 'CONTROLLER_ACTIONS',
            template: 'controller-action.hbs',
            position: 'before-end',
            hashTrailerPrefix: '// scaffold-hash:',
            strategy: 'append',
            artifact: 'custom-endpoint',
          },
          {
            file: 'src/Repositories/I{{entity}}Repository.cs',
            marker: 'REPO_INTERFACE_METHODS',
            template: 'repo-interface-method.hbs',
            position: 'before-end',
            hashTrailerPrefix: '// scaffold-hash:',
            strategy: 'append',
            artifact: 'custom-endpoint',
            when: { 'options.combine': false },
          },
          {
            file: 'src/Repositories/{{entity}}Repository.cs',
            marker: 'REPO_INTERFACE_METHODS',
            template: 'repo-interface-method.hbs',
            position: 'before-end',
            hashTrailerPrefix: '// scaffold-hash:',
            strategy: 'append',
            artifact: 'custom-endpoint',
            when: { 'options.combine': true },
          },
          {
            file: 'src/Repositories/{{entity}}Repository.cs',
            marker: 'REPO_IMPL_METHODS',
            template: 'repo-impl-method.hbs',
            position: 'before-end',
            hashTrailerPrefix: '// scaffold-hash:',
            strategy: 'append',
            artifact: 'custom-endpoint',
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(versionDir, 'Controller.cs.hbs'), CONTROLLER_TEMPLATE);
  writeFileSync(path.join(versionDir, 'RepoInterface.cs.hbs'), REPO_INTERFACE_TEMPLATE);
  writeFileSync(path.join(versionDir, 'RepoImpl.cs.hbs'), REPO_IMPL_TEMPLATE);
  writeFileSync(path.join(versionDir, 'RepoCombined.cs.hbs'), REPO_COMBINED_TEMPLATE);
  writeFileSync(path.join(versionDir, 'CreateCommand.cs.hbs'), CREATE_COMMAND_TEMPLATE);
  writeFileSync(path.join(versionDir, 'ReadQuery.cs.hbs'), READ_QUERY_TEMPLATE);
  writeFileSync(path.join(versionDir, 'CustomHandler.cs.hbs'), CUSTOM_HANDLER_TEMPLATE);
  writeFileSync(path.join(versionDir, 'DomainEvent.cs.hbs'), DOMAIN_EVENT_TEMPLATE);
  writeFileSync(path.join(versionDir, 'controller-action.hbs'), CONTROLLER_ACTION_SNIPPET);
  writeFileSync(path.join(versionDir, 'repo-interface-method.hbs'), REPO_INTERFACE_METHOD_SNIPPET);
  writeFileSync(path.join(versionDir, 'repo-impl-method.hbs'), REPO_IMPL_METHOD_SNIPPET);
  return dir;
}

function setupTarget(packDir: string, defaults?: Record<string, unknown>): string {
  const targetRepo = mkdtempSync(path.join(tmpdir(), 'scaffold-add-target-'));
  saveConfig(targetRepo, {
    projectType: 'dotnet',
    packs: { backend: { path: packDir, version: 'v9', ...(defaults ? { defaults } : {}) } },
  });
  return targetRepo;
}

test('add feature: operations subset renders only those artifacts plus base', async () => {
  const packDir = buildEnterpriseFixturePack();
  const targetRepo = setupTarget(packDir);

  const manifest = compileAddFeature({ targetStack: 'backend', name: 'Product', properties: 'Name:string', operations: 'Create' });
  const report = await runGenerate({ repoRoot: targetRepo, manifest, dryRun: false, force: false });

  assert.deepEqual(
    report.created.map((c) => c.file).sort(),
    [
      'src/Commands/CreateProductCommand.cs',
      'src/Controllers/ProductsController.cs',
      'src/Repositories/IProductRepository.cs',
      'src/Repositories/ProductRepository.cs',
    ],
  );
  assert.equal(existsSync(path.join(targetRepo, 'src/Queries/GetProductQuery.cs')), false);
  // The required AI seam in the handler is reported for the agent.
  assert.equal(report.aiImplementation.length, 1);
  assert.equal(report.aiImplementation[0].required, true);
});

test('add feature --combine: one repository file with both zones instead of two files', async () => {
  const packDir = buildEnterpriseFixturePack();
  const targetRepo = setupTarget(packDir);

  const manifest = compileAddFeature({ targetStack: 'backend', name: 'Product', properties: 'Name:string', operations: 'Read', combine: true });
  await runGenerate({ repoRoot: targetRepo, manifest, dryRun: false, force: false });

  const combinedPath = path.join(targetRepo, 'src/Repositories/ProductRepository.cs');
  assert.ok(existsSync(combinedPath));
  assert.equal(existsSync(path.join(targetRepo, 'src/Repositories/IProductRepository.cs')), false);
  const combined = readFileSync(combinedPath, 'utf8');
  assert.match(combined, /public interface IProductRepository/);
  assert.match(combined, /public class ProductRepository/);
  assert.match(combined, /REPO_INTERFACE_METHODS/);
  assert.match(combined, /REPO_IMPL_METHODS/);
});

test('add custom: injects the action into the existing controller and the method into both repo zones (split layout)', async () => {
  const packDir = buildEnterpriseFixturePack();
  const targetRepo = setupTarget(packDir);

  // First a feature to lay down the controller + split repository.
  await runGenerate({
    repoRoot: targetRepo,
    manifest: compileAddFeature({ targetStack: 'backend', name: 'Product', properties: 'Name:string', operations: 'Create' }),
    dryRun: false,
    force: false,
  });

  const customManifest = compileAddCustom({
    targetStack: 'backend',
    name: 'GetProductsWithFilter',
    returnType: 'PagedResult',
    parameters: 'page:int,pageSize:int',
    targetController: 'ProductsController',
  });
  const report = await runGenerate({ repoRoot: targetRepo, manifest: customManifest, dryRun: false, force: false });

  assert.deepEqual(report.created.map((c) => c.file), ['src/Queries/GetProductsWithFilterHandler.cs']);
  assert.deepEqual(
    report.injected.map((i) => `${i.file}#${i.marker}`).sort(),
    [
      'src/Controllers/ProductsController.cs#CONTROLLER_ACTIONS',
      'src/Repositories/IProductRepository.cs#REPO_INTERFACE_METHODS',
      'src/Repositories/ProductRepository.cs#REPO_IMPL_METHODS',
    ],
  );
  const controller = readFileSync(path.join(targetRepo, 'src/Controllers/ProductsController.cs'), 'utf8');
  assert.match(controller, /public PagedResult GetProductsWithFilter\(\)/);
  const iface = readFileSync(path.join(targetRepo, 'src/Repositories/IProductRepository.cs'), 'utf8');
  assert.match(iface, /PagedResult GetProductsWithFilterAsync\(\);/);
  const impl = readFileSync(path.join(targetRepo, 'src/Repositories/ProductRepository.cs'), 'utf8');
  assert.match(impl, /public PagedResult GetProductsWithFilterAsync\(\)/);

  // Re-running the exact same custom operation refuses on the create-mode
  // handler; the injections alone are idempotent, proven by the dry-run diff
  // being impossible to reach — so assert the refusal is the create collision.
  await assert.rejects(
    () => runGenerate({ repoRoot: targetRepo, manifest: customManifest, dryRun: false, force: false }),
    /already exists/,
  );
});

test('add custom on a combined repository injects both methods into the single file', async () => {
  const packDir = buildEnterpriseFixturePack();
  const targetRepo = setupTarget(packDir, { options: { combine: true } });

  await runGenerate({
    repoRoot: targetRepo,
    manifest: compileAddFeature({ targetStack: 'backend', name: 'Product', properties: 'Name:string', operations: 'Create' }),
    dryRun: false,
    force: false,
  });

  // The pack default (combine: true) applies to the custom run too — no --combine flag needed.
  const report = await runGenerate({
    repoRoot: targetRepo,
    manifest: compileAddCustom({ targetStack: 'backend', name: 'CountProducts', returnType: 'Int32', targetController: 'ProductsController' }),
    dryRun: false,
    force: false,
  });

  assert.deepEqual(
    report.injected.map((i) => `${i.file}#${i.marker}`).sort(),
    [
      'src/Controllers/ProductsController.cs#CONTROLLER_ACTIONS',
      'src/Repositories/ProductRepository.cs#REPO_IMPL_METHODS',
      'src/Repositories/ProductRepository.cs#REPO_INTERFACE_METHODS',
    ],
  );
  const combined = readFileSync(path.join(targetRepo, 'src/Repositories/ProductRepository.cs'), 'utf8');
  assert.match(combined, /Int32 CountProductsAsync\(\);/);
  assert.match(combined, /public Int32 CountProductsAsync\(\)/);
});

test('add domain-event: renders exactly the event file, nothing else', async () => {
  const packDir = buildEnterpriseFixturePack();
  const targetRepo = setupTarget(packDir);

  const report = await runGenerate({
    repoRoot: targetRepo,
    manifest: compileAddArtifact('domain-event', { targetStack: 'backend', name: 'ProductCreated' }),
    dryRun: false,
    force: false,
  });

  assert.deepEqual(report.created.map((c) => c.file), ['src/Events/ProductCreatedEvent.cs']);
  assert.equal(report.injected.length, 0);
  assert.match(readFileSync(path.join(targetRepo, 'src/Events/ProductCreatedEvent.cs'), 'utf8'), /public record ProductCreatedEvent/);
});

test('add feature: dry-run report equals the real run report', async () => {
  const packDir = buildEnterpriseFixturePack();
  const dryRepo = setupTarget(packDir);
  const realRepo = setupTarget(packDir);

  const manifest = compileAddFeature({ targetStack: 'backend', name: 'Order', properties: 'Total:decimal', operations: 'Create,Read' });
  const dry = await runGenerate({ repoRoot: dryRepo, manifest, dryRun: true, force: false });
  const real = await runGenerate({ repoRoot: realRepo, manifest, dryRun: false, force: false });

  assert.deepEqual(dry.created, real.created);
  assert.deepEqual(dry.injected, real.injected);
  assert.deepEqual(dry.aiImplementation, real.aiImplementation);
});

test('CLI wiring: scaffold add feature --dry-run runs end-to-end through dist/cli.js', () => {
  assert.ok(existsSync(SCAFFOLD_CLI), `dist not built — run \`npm run build\` first (expected ${SCAFFOLD_CLI})`);
  const packDir = buildEnterpriseFixturePack();
  const targetRepo = setupTarget(packDir);

  const stdout = execFileSync(
    process.execPath,
    [
      SCAFFOLD_CLI,
      'add',
      'feature',
      '--name',
      'Invoice',
      '--properties',
      'Amount:decimal',
      '--operations',
      'Create',
      '--dry-run',
      '--json',
    ],
    { cwd: targetRepo, encoding: 'utf8' },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.artifacts, ['base', 'op-create']);
  assert.ok(report.created.some((c: { file: string }) => c.file === 'src/Commands/CreateInvoiceCommand.cs'));
  // Dry run: nothing written.
  assert.equal(existsSync(path.join(targetRepo, 'src/Commands/CreateInvoiceCommand.cs')), false);
});
