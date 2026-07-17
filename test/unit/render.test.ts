import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderTemplateFile, renderPathTemplate } from '../../src/generate/render.js';

test('renderTemplateFile substitutes entity and field context', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Endpoint.cs.hbs');
  writeFileSync(templatePath, 'public class {{entity}}Endpoint { /* route: {{options.route}} */ }');
  const output = renderTemplateFile(templatePath, { entity: 'Invoice', options: { route: '/api/invoices' } });
  assert.equal(output, 'public class InvoiceEndpoint { /* route: /api/invoices */ }');
});

test('renderTemplateFile does not HTML-escape quotes or angle brackets (noEscape: true)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Route.cs.hbs');
  writeFileSync(templatePath, 'app.MapGet("{{options.route}}", () => Results.Ok<{{entity}}>());');
  const output = renderTemplateFile(templatePath, { entity: 'Invoice', options: { route: '/api/invoices' } });
  assert.equal(output, 'app.MapGet("/api/invoices", () => Results.Ok<Invoice>());');
});

test('renderPathTemplate substitutes the entity into an output path', () => {
  const output = renderPathTemplate('src/Endpoints/{{entity}}Endpoint.cs', { entity: 'Invoice' });
  assert.equal(output, 'src/Endpoints/InvoiceEndpoint.cs');
});

test('renderTemplateFile iterates a fields array', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Dto.cs.hbs');
  writeFileSync(templatePath, '{{#each fields}}public {{type}} {{name}};\n{{/each}}');
  const output = renderTemplateFile(templatePath, {
    fields: [
      { name: 'Id', type: 'Guid' },
      { name: 'Amount', type: 'decimal' },
    ],
  });
  assert.equal(output, 'public Guid Id;\npublic decimal Amount;\n');
});

test('renderTemplateFile supports camel case helper', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Case.hbs');
  writeFileSync(templatePath, '{{camel entity}}');
  const output = renderTemplateFile(templatePath, { entity: 'InvoiceEndpoint' });
  assert.equal(output, 'invoiceEndpoint');
});

test('renderTemplateFile supports Camel case helper with capital C', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Case.hbs');
  writeFileSync(templatePath, '{{Camel entity}}');
  const output = renderTemplateFile(templatePath, { entity: 'InvoiceEndpoint' });
  assert.equal(output, 'invoiceEndpoint');
});

test('renderTemplateFile supports pascal case helper', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Case.hbs');
  writeFileSync(templatePath, '{{pascal entity}}');
  const output = renderTemplateFile(templatePath, { entity: 'invoice_endpoint' });
  assert.equal(output, 'InvoiceEndpoint');
});

test('renderTemplateFile supports snake case helper', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Case.hbs');
  writeFileSync(templatePath, '{{snake entity}}');
  const output = renderTemplateFile(templatePath, { entity: 'InvoiceEndpoint' });
  assert.equal(output, 'invoice_endpoint');
});

test('renderTemplateFile supports kebab case helper', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Case.hbs');
  writeFileSync(templatePath, '{{kebab entity}}');
  const output = renderTemplateFile(templatePath, { entity: 'InvoiceEndpoint' });
  assert.equal(output, 'invoice-endpoint');
});

test('renderTemplateFile supports upper case helper', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Case.hbs');
  writeFileSync(templatePath, '{{upper entity}}');
  const output = renderTemplateFile(templatePath, { entity: 'invoice' });
  assert.equal(output, 'INVOICE');
});

test('renderTemplateFile supports lower case helper', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-render-'));
  const templatePath = path.join(dir, 'Case.hbs');
  writeFileSync(templatePath, '{{lower entity}}');
  const output = renderTemplateFile(templatePath, { entity: 'INVOICE' });
  assert.equal(output, 'invoice');
});

test('buildHandlebarsContext passes host-precomputed top-level manifest fields (entityCamel, entityPlural, …) through to templates, with manifest fields winning over options keys', async () => {
  const { buildHandlebarsContext } = await import('../../src/generate/generate.js');
  const context = buildHandlebarsContext({
    manifestSchemaVersion: 1,
    targetStack: 'frontend',
    entity: 'Invoice',
    entityCamel: 'invoice',
    entityPlural: 'Invoices',
    primaryKeyField: 'id',
    fields: [{ name: 'id', type: 'guid' }],
    options: { route: '/api/invoices', entityCamel: 'shadowed' },
  });
  assert.equal(context.entityCamel, 'invoice', 'top-level manifest field must win over the options key');
  assert.equal(context.entityPlural, 'Invoices');
  assert.equal(context.primaryKeyField, 'id');
  assert.equal(context.route, '/api/invoices', 'options keys still spread for convenience');
  assert.equal((context.options as Record<string, unknown>).route, '/api/invoices');
});

// arch-brownfield-adoption.html E5: a pack slot's persisted pathConfig/
// companyProjectName (config/schema.ts's PackConfig) is the lowest-
// precedence source in the render context — a manifest that still supplies
// either keeps overriding it exactly as before adoption existed.
test('buildHandlebarsContext: packDefaults (persisted pathConfig/companyProjectName) apply only when the manifest does not already supply them', async () => {
  const { buildHandlebarsContext } = await import('../../src/generate/generate.js');

  const withoutManifestOverride = buildHandlebarsContext(
    { manifestSchemaVersion: 1, targetStack: 'backend', entity: 'Order' },
    { companyProjectName: 'Acme', pathConfig: { apiControllers: 'Services' } },
  );
  assert.equal(withoutManifestOverride.companyProjectName, 'Acme');
  assert.deepEqual(withoutManifestOverride.pathConfig, { apiControllers: 'Services' });

  const withManifestOverride = buildHandlebarsContext(
    { manifestSchemaVersion: 1, targetStack: 'backend', entity: 'Order', companyProjectName: 'FromManifest' },
    { companyProjectName: 'Acme', pathConfig: { apiControllers: 'Services' } },
  );
  assert.equal(withManifestOverride.companyProjectName, 'FromManifest', 'manifest-supplied value must still win');
});
