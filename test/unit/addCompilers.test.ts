import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlot, parsePropertyList } from '../../src/add/common.js';
import { compileAddFeature, parseOperations } from '../../src/add/addFeature.js';
import { compileAddCustom, deriveEntity } from '../../src/add/addCustom.js';
import { compileAddArtifact, ARTIFACT_KINDS } from '../../src/add/addArtifact.js';

// --- resolveSlot -----------------------------------------------------------

const twoSlotConfig = {
  projectType: 'dotnet',
  packs: {
    backend: { path: 'packs/dotnet', version: 'v9' },
    frontend: { path: 'packs/react', version: 'v1' },
  },
};

test('resolveSlot: explicit --template-set names the slot; unknown slot errors with the available names', () => {
  assert.equal(resolveSlot(twoSlotConfig, 'frontend'), 'frontend');
  assert.throws(() => resolveSlot(twoSlotConfig, 'nope'), /configured slots: backend, frontend/);
});

test('resolveSlot: sole slot is the default; multiple slots without --template-set is ambiguous', () => {
  assert.equal(resolveSlot({ projectType: 'dotnet', packs: { backend: { path: 'p', version: 'v1' } } }), 'backend');
  assert.throws(() => resolveSlot(twoSlotConfig), /--template-set/);
  assert.throws(() => resolveSlot({ projectType: 'dotnet', packs: {} }), /scaffold init/);
});

// --- parsePropertyList -----------------------------------------------------

test('parsePropertyList: splits on commas, trims, and keeps generic types whole', () => {
  assert.deepEqual(parsePropertyList('Name:string, Price:decimal', '--properties'), [
    { name: 'Name', type: 'string' },
    { name: 'Price', type: 'decimal' },
  ]);
  assert.deepEqual(parsePropertyList('Lookup:Dictionary<string,int>,Tags:List<string>', '--properties'), [
    { name: 'Lookup', type: 'Dictionary<string,int>' },
    { name: 'Tags', type: 'List<string>' },
  ]);
});

test('parsePropertyList: empty list and malformed pairs are authoring errors naming the flag', () => {
  assert.throws(() => parsePropertyList('  ,  ', '--properties'), /--properties is empty/);
  assert.throws(() => parsePropertyList('NameOnly', '--parameters'), /invalid --parameters/);
});

// --- add feature -----------------------------------------------------------

test('parseOperations: defaults to all four in fixed order; subset keeps fixed order regardless of input order', () => {
  assert.deepEqual(parseOperations(undefined).tags, ['op-create', 'op-read', 'op-update', 'op-delete']);
  assert.deepEqual(parseOperations('Read,Create').tags, ['op-create', 'op-read']);
  assert.deepEqual(parseOperations('delete').ops, { create: false, read: false, update: false, delete: true });
  assert.throws(() => parseOperations('Create,Upsert'), /invalid --operations value\(s\): upsert/);
});

test('compileAddFeature: full-flag manifest shape', () => {
  const manifest = compileAddFeature({
    targetStack: 'backend',
    name: 'Product',
    properties: 'Name:string,Price:decimal',
    db: 'Tenant',
    operations: 'Create,Read',
    controller: 'CatalogController',
    namespace: 'Acme.Shop',
    target: 'V3',
    combine: true,
  });
  assert.deepEqual(manifest, {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity: 'Product',
    fields: [
      { name: 'Name', type: 'string' },
      { name: 'Price', type: 'decimal' },
    ],
    options: {
      ops: { create: true, read: true, update: false, delete: false },
      database: { scope: 'Tenant' },
      combine: true,
      controllerName: 'CatalogController',
      targetFolder: 'V3',
    },
    artifacts: ['base', 'op-create', 'op-read'],
    companyProjectName: 'Acme.Shop',
  });
});

test('compileAddFeature: minimal flags leave optional options unset so pack defaults can apply', () => {
  const manifest = compileAddFeature({ targetStack: 'backend', name: 'Order', properties: 'Total:decimal' });
  assert.deepEqual(manifest.artifacts, ['base', 'op-create', 'op-read', 'op-update', 'op-delete']);
  assert.deepEqual(manifest.options, { ops: { create: true, read: true, update: true, delete: true } });
  assert.equal('companyProjectName' in manifest, false);
});

test('compileAddFeature: non-PascalCase entity fails manifest validation', () => {
  assert.throws(() => compileAddFeature({ targetStack: 'backend', name: 'product', properties: 'Name:string' }));
});

// --- add custom ------------------------------------------------------------

test('deriveEntity: explicit entity wins; controller name strips Controller suffix and plural s', () => {
  assert.equal(deriveEntity('ProductsController', 'Sku'), 'Sku');
  assert.equal(deriveEntity('ProductsController', undefined), 'Product');
  assert.equal(deriveEntity('InventoryController', undefined), 'Inventory');
  assert.throws(() => deriveEntity(undefined, undefined), /--target-controller or --entity/);
});

test('compileAddCustom: full-flag manifest shape', () => {
  const manifest = compileAddCustom({
    targetStack: 'backend',
    name: 'GetProductsWithFilter',
    returnType: 'PagedResult',
    parameters: 'page:int,pageSize:int',
    method: 'get',
    route: 'api/v2/products/filter',
    targetController: 'ProductsController',
    isCommand: undefined,
    combine: true,
  });
  assert.deepEqual(manifest, {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity: 'Product',
    options: { combine: true },
    artifacts: ['custom-endpoint'],
    methodName: 'GetProductsWithFilter',
    returnType: 'PagedResult',
    httpMethod: 'GET',
    targetController: 'ProductsController',
    parameters: [
      { name: 'page', type: 'int' },
      { name: 'pageSize', type: 'int' },
    ],
    route: 'api/v2/products/filter',
  });
});

test('compileAddCustom: defaults — GET, controller derived from entity, empty parameters, no route key', () => {
  const manifest = compileAddCustom({ targetStack: 'backend', name: 'ArchiveProduct', returnType: 'Unit', entity: 'Product', isCommand: true });
  assert.equal(manifest.httpMethod, 'GET');
  assert.equal(manifest.targetController, 'ProductsController');
  assert.deepEqual(manifest.parameters, []);
  assert.equal('route' in manifest, false);
  assert.deepEqual(manifest.options, { isCommand: true });
});

test('compileAddCustom: rejects bad operation names and HTTP methods', () => {
  assert.throws(
    () => compileAddCustom({ targetStack: 'backend', name: 'getStuff', returnType: 'X', entity: 'Product' }),
    /PascalCase operation name/,
  );
  assert.throws(
    () => compileAddCustom({ targetStack: 'backend', name: 'GetStuff', returnType: 'X', entity: 'Product', method: 'FETCH' }),
    /expected one of GET, POST/,
  );
});

// --- add <artifact> --------------------------------------------------------

test('compileAddArtifact: each kind produces its artifact tag and inputs', () => {
  assert.deepEqual(compileAddArtifact('domain-event', { targetStack: 'backend', name: 'ProductCreated', entity: 'Product' }), {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    artifacts: ['domain-event'],
    eventName: 'ProductCreated',
    entity: 'Product',
  });
  assert.deepEqual(compileAddArtifact('factory', { targetStack: 'backend', entity: 'Product' }), {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    artifacts: ['factory'],
    entity: 'Product',
  });
  assert.deepEqual(compileAddArtifact('helper', { targetStack: 'backend', name: 'Guard' }).artifacts, ['helper-guard']);
  assert.deepEqual(compileAddArtifact('cloud-provider', { targetStack: 'backend', provider: 'Azure' }), {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    artifacts: ['cloud-provider'],
    options: { cloudProvider: 'azure' },
  });
  assert.deepEqual(compileAddArtifact('scheduler-job', { targetStack: 'backend', name: 'NightlyCleanup', scheduler: 'quartz' }), {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    artifacts: ['scheduler-job'],
    jobName: 'NightlyCleanup',
    options: { scheduler: 'quartz' },
  });
  // --scheduler is optional: the v9 job skeleton is BCL-only.
  assert.equal('options' in compileAddArtifact('scheduler-job', { targetStack: 'backend', name: 'NightlyCleanup' }), false);
  assert.deepEqual(compileAddArtifact('health-check', { targetStack: 'backend', name: 'Database' }).checkName, 'Database');
  assert.deepEqual(compileAddArtifact('outbox-processor', { targetStack: 'backend' }).artifacts, ['outbox']);
});

test('compileAddArtifact: missing/invalid flags fail with the flag hint', () => {
  assert.throws(() => compileAddArtifact('domain-event', { targetStack: 'backend' }), /--name <EventName>/);
  assert.throws(() => compileAddArtifact('factory', { targetStack: 'backend' }), /--entity <Entity>/);
  assert.throws(() => compileAddArtifact('helper', { targetStack: 'backend', name: 'zip' }), /"guard" or "crypto"/);
  assert.throws(() => compileAddArtifact('cloud-provider', { targetStack: 'backend', provider: 'ibm' }), /aws\|azure\|gcp/);
  assert.throws(() => compileAddArtifact('scheduler-job', { targetStack: 'backend', name: 'X', scheduler: 'cron' }), /quartz\|hangfire/);
  assert.throws(() => compileAddArtifact('domain-event', { targetStack: 'backend', name: 'lowercase' }), /PascalCase/);
  assert.throws(() => compileAddArtifact('no-such-kind', { targetStack: 'backend' }), /unknown artifact kind/);
});

test('ARTIFACT_KINDS: table covers exactly the seven single-artifact kinds', () => {
  assert.deepEqual(Object.keys(ARTIFACT_KINDS).sort(), [
    'cloud-provider',
    'domain-event',
    'factory',
    'health-check',
    'helper',
    'outbox-processor',
    'scheduler-job',
  ]);
});
