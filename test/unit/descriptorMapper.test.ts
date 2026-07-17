import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mapDescriptorToRepo, adoptedPathKey } from '../../src/bootstrapMarkers/descriptorMapper.js';
import type { TemplateDescriptor } from '../../src/descriptor/schema.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function baseDescriptor(overrides: Partial<TemplateDescriptor>): TemplateDescriptor {
  return {
    descriptorSchemaVersion: 2,
    packVersion: 'v1',
    requires: { scaffoldCli: '>=0.0.0' },
    targets: [],
    injections: [],
    ...overrides,
  };
}

test('adoptedPathKey: entity-free vs per-entity keys', () => {
  assert.equal(adoptedPathKey('injection', 'Program.cs'), 'injection:Program.cs');
  assert.equal(adoptedPathKey('target', 'src/{{entity}}Controller.cs', 'Order'), 'target:src/{{entity}}Controller.cs::Order');
});

test('mapDescriptorToRepo: a single confident match for an entity-free injection template', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-mapper-'));
  writeFileSync(path.join(repo, 'Program.cs'), 'content');
  const descriptor = baseDescriptor({
    injections: [{ file: 'Program.cs', marker: 'DI', template: 'x.hbs', position: 'before-end', hashTrailerPrefix: '// h:' }],
  });

  const result = mapDescriptorToRepo(repo, descriptor, {}, false);
  assert.equal(result.mapped.length, 1);
  assert.deepEqual(result.mapped[0], { kind: 'injection', template: 'Program.cs', file: 'Program.cs' });
  assert.equal(result.needsManual.length, 0);
});

test('mapDescriptorToRepo: zero matches for an entity-free template is silently not-actionable (no needsManual entry)', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-mapper-'));
  const descriptor = baseDescriptor({
    injections: [{ file: 'Program.cs', marker: 'DI', template: 'x.hbs', position: 'before-end', hashTrailerPrefix: '// h:' }],
  });

  const result = mapDescriptorToRepo(repo, descriptor, {}, false);
  assert.equal(result.mapped.length, 0);
  assert.equal(result.needsManual.length, 0);
});

test('mapDescriptorToRepo: multiple matches for an entity-free template is needsManual, never guessed', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-mapper-'));
  mkdirSync(path.join(repo, 'a'));
  mkdirSync(path.join(repo, 'b'));
  writeFileSync(path.join(repo, 'a', 'Program.cs'), 'x');
  writeFileSync(path.join(repo, 'b', 'Program.cs'), 'x');
  // An unresolved {{pathConfig.dir}} (no context supplied) is a wildcard
  // segment, same as "Program.cs" alone would be for the previous test's
  // fully-literal template — a literal-only template can only ever have one
  // possible match by construction, so ambiguity needs a wildcard segment.
  const descriptor = baseDescriptor({
    injections: [{ file: '{{pathConfig.dir}}/Program.cs', marker: 'DI', template: 'x.hbs', position: 'before-end', hashTrailerPrefix: '// h:' }],
  });

  const result = mapDescriptorToRepo(repo, descriptor, {}, false);
  assert.equal(result.mapped.length, 0);
  assert.equal(result.needsManual.length, 1);
  assert.equal(result.needsManual[0].kind, 'injection');
  assert.match(result.needsManual[0].reason, /expected exactly one/);
});

test('mapDescriptorToRepo: a per-entity target template maps each distinct entity to its own file', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-mapper-'));
  mkdirSync(path.join(repo, 'src', 'Controllers'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'Controllers', 'OrderController.cs'), 'x');
  writeFileSync(path.join(repo, 'src', 'Controllers', 'CustomerController.cs'), 'x');
  const descriptor = baseDescriptor({
    targets: [{ output: 'src/Controllers/{{entity}}Controller.cs', template: 't.hbs', mode: 'create' }],
  });

  const result = mapDescriptorToRepo(repo, descriptor, {}, false);
  assert.equal(result.mapped.length, 2);
  const byEntity = Object.fromEntries(result.mapped.map((m) => [m.entity, m.file]));
  assert.equal(byEntity.Order, path.posix.join('src', 'Controllers', 'OrderController.cs'));
  assert.equal(byEntity.Customer, path.posix.join('src', 'Controllers', 'CustomerController.cs'));
  assert.equal(result.needsManual.length, 0);
});

test('mapDescriptorToRepo: two files for the same entity value is needsManual for that entity only, others still map', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-mapper-'));
  mkdirSync(path.join(repo, 'src', 'Controllers'), { recursive: true });
  mkdirSync(path.join(repo, 'src', 'Legacy'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'Controllers', 'OrderController.cs'), 'x');
  writeFileSync(path.join(repo, 'src', 'Legacy', 'CustomerController.cs'), 'x');
  writeFileSync(path.join(repo, 'src', 'Controllers', 'CustomerController.cs'), 'x');
  const descriptor = baseDescriptor({
    targets: [{ output: 'src/{{pathConfig.dir}}/{{entity}}Controller.cs', template: 't.hbs', mode: 'create' }],
  });

  const result = mapDescriptorToRepo(repo, descriptor, {}, false);
  assert.equal(result.mapped.length, 1);
  assert.equal(result.mapped[0].entity, 'Order');
  assert.equal(result.needsManual.length, 1);
  assert.equal(result.needsManual[0].entity, 'Customer');
});

test('mapDescriptorToRepo: resolves a repo directory-layout mismatch once pathConfig/companyProjectName are supplied in context', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-mapper-'));
  mkdirSync(path.join(repo, 'Services'), { recursive: true });
  writeFileSync(path.join(repo, 'Services', 'OrderController.cs'), 'x');
  const descriptor = baseDescriptor({
    targets: [{ output: 'src/{{companyProjectName}}.Api/{{pathConfig.apiControllers}}/{{entity}}Controller.cs', template: 't.hbs', mode: 'create' }],
  });

  // No context: the literal "src/*.Api/" prefix never matches "Services/".
  const withoutContext = mapDescriptorToRepo(repo, descriptor, {}, false);
  assert.equal(withoutContext.mapped.length, 0);

  // pathConfig escapes the hardcoded "src/*.Api/" prefix via a relative
  // override ("../../Services"), matching E2 of arch-brownfield-adoption.html —
  // resolveTemplatePattern normalizes the "../.." against the (now-resolved)
  // literal companyProjectName segment exactly as path.join would.
  const withContext = mapDescriptorToRepo(repo, descriptor, { pathConfig: { apiControllers: '../../Services' }, companyProjectName: 'Acme' }, false);
  assert.equal(withContext.mapped.length, 1);
  assert.equal(withContext.mapped[0].file, 'Services/OrderController.cs');
  assert.equal(withContext.mapped[0].entity, 'Order');
});

test('mapDescriptorToRepo: git-safety excludes dirty/untracked matches from confident mapping', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-mapper-git-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Scaffold Test']);
  writeFileSync(path.join(repo, 'Program.cs'), 'committed');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  writeFileSync(path.join(repo, 'Program.cs'), 'dirty edit');

  const descriptor = baseDescriptor({
    injections: [{ file: 'Program.cs', marker: 'DI', template: 'x.hbs', position: 'before-end', hashTrailerPrefix: '// h:' }],
  });

  const result = mapDescriptorToRepo(repo, descriptor, {}, true);
  assert.equal(result.mapped.length, 0);
  assert.equal(result.needsManual.length, 0, 'a dirty file is simply not a candidate — not actionable as ambiguous either');
});

test('mapDescriptorToRepo: outside a git work tree, no git-safety filtering is applied', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-mapper-'));
  writeFileSync(path.join(repo, 'Program.cs'), 'content');
  const descriptor = baseDescriptor({
    injections: [{ file: 'Program.cs', marker: 'DI', template: 'x.hbs', position: 'before-end', hashTrailerPrefix: '// h:' }],
  });

  const result = mapDescriptorToRepo(repo, descriptor, {}, false);
  assert.equal(result.mapped.length, 1);
});
