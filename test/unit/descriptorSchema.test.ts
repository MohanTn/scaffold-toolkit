import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateDescriptor, loadDescriptor, DescriptorValidationError, DescriptorRequiresMismatchError } from '../../src/descriptor/load.js';

function baseDescriptor() {
  return {
    descriptorSchemaVersion: 2,
    packVersion: 'v10-minimal-api',
    requires: { scaffoldCli: '>=1.0.0 <2.0.0' },
    targets: [{ output: 'src/Endpoints/{{entity}}Endpoint.cs', template: 'Endpoint.cs.hbs', mode: 'create' }],
    injections: [
      { file: 'Program.cs', marker: 'SCAFFOLD_DI', template: 'di-registration.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' },
    ],
  };
}

test('validateDescriptor accepts a well-formed v2 descriptor and allows unknown top-level fields', () => {
  const descriptor = { ...baseDescriptor(), someFutureField: 'ok' };
  assert.deepEqual(validateDescriptor(descriptor), descriptor);
});

test('validateDescriptor rejects an unknown field inside a targets[] entry', () => {
  const descriptor = baseDescriptor();
  (descriptor.targets[0] as Record<string, unknown>).typoField = 'oops';
  assert.throws(() => validateDescriptor(descriptor), DescriptorValidationError);
});

test('validateDescriptor rejects an unknown field inside an injections[] entry', () => {
  const descriptor = baseDescriptor();
  (descriptor.injections[0] as Record<string, unknown>).typoField = 'oops';
  assert.throws(() => validateDescriptor(descriptor), DescriptorValidationError);
});

test('validateDescriptor rejects a marker starting with the reserved AI_IMPLEMENTATION namespace', () => {
  const descriptor = baseDescriptor();
  descriptor.injections[0].marker = 'AI_IMPLEMENTATION_EXTRA';
  assert.throws(() => validateDescriptor(descriptor), DescriptorValidationError);
});

test('validateDescriptor rejects an invalid mode value', () => {
  const descriptor = baseDescriptor();
  (descriptor.targets[0] as { mode: string }).mode = 'delete';
  assert.throws(() => validateDescriptor(descriptor), DescriptorValidationError);
});

test('loadDescriptor passes when the installed CLI version satisfies requires.scaffoldCli', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-descriptor-'));
  const file = path.join(dir, 'manifest.templates.json');
  writeFileSync(file, JSON.stringify(baseDescriptor()));
  const descriptor = loadDescriptor(file, '1.2.3');
  assert.equal(descriptor.packVersion, 'v10-minimal-api');
});

test('loadDescriptor throws DescriptorRequiresMismatchError when the installed CLI version is outside requires.scaffoldCli', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-descriptor-'));
  const file = path.join(dir, 'manifest.templates.json');
  writeFileSync(file, JSON.stringify(baseDescriptor()));
  assert.throws(() => loadDescriptor(file, '2.5.0'), DescriptorRequiresMismatchError);
});

test('validateDescriptor accepts strategy "append" on an injections[] entry and rejects an unknown strategy value', () => {
  const withAppend = baseDescriptor();
  (withAppend.injections[0] as Record<string, unknown>).strategy = 'append';
  assert.deepEqual(validateDescriptor(withAppend), withAppend);

  const withBogus = baseDescriptor();
  (withBogus.injections[0] as Record<string, unknown>).strategy = 'merge';
  assert.throws(() => validateDescriptor(withBogus), DescriptorValidationError);
});

// --- v2 additive descriptor fields (axis 1/2/3 of the pack-driven plan) ---

test('validateDescriptor accepts an optional inputs[] declaration', () => {
  const d = { ...baseDescriptor(), inputs: [{ name: 'aggregate', type: 'string', required: true, pattern: '^[A-Z][A-Za-z0-9]+$' }] };
  assert.deepEqual(validateDescriptor(d), d);
});

test('validateDescriptor rejects inputs[] entries with an unknown type', () => {
  const d: Record<string, unknown> = { ...baseDescriptor(), inputs: [{ name: 'aggregate', type: 'decimal' }] };
  assert.throws(() => validateDescriptor(d), DescriptorValidationError);
});

test('validateDescriptor accepts an optional commentSyntax map with {prefix} and {wrap} entries', () => {
  const d = { ...baseDescriptor(), commentSyntax: { '.sql': { prefix: '--' }, '.razor': { wrap: ['@* ', ' *@'] } } };
  assert.deepEqual(validateDescriptor(d), d);
});

test('validateDescriptor rejects commentSyntax entries that are neither {prefix} nor {wrap:[a,b]}', () => {
  const d: Record<string, unknown> = { ...baseDescriptor(), commentSyntax: { '.sql': { wrongShape: '--' } } };
  assert.throws(() => validateDescriptor(d), DescriptorValidationError);
});

test('validateDescriptor rejects a commentSyntax wrap entry whose tuple length is not exactly 2', () => {
  const d: Record<string, unknown> = { ...baseDescriptor(), commentSyntax: { '.sql': { wrap: ['@* '] } } };
  assert.throws(() => validateDescriptor(d), DescriptorValidationError);
});

test('validateDescriptor accepts an optional bootstrapAnchors[] declaring after-line and after-class-brace kinds', () => {
  const d = {
    ...baseDescriptor(),
    bootstrapAnchors: [
      { candidateFilenames: ['app.py'], anchor: { kind: 'after-line', pattern: '\\bdef\\s+main\\(' }, markers: ['REGISTRY'] },
      { candidateFilenames: ['models.py'], anchor: { kind: 'after-class-brace', declarationPattern: '\\bclass\\s+Order\\b' }, markers: ['REPOSITORY'] },
    ],
  };
  assert.deepEqual(validateDescriptor(d), d);
});

test('validateDescriptor rejects bootstrapAnchors entries with an unknown anchor kind', () => {
  const d: Record<string, unknown> = { ...baseDescriptor(), bootstrapAnchors: [{ candidateFilenames: ['app.py'], anchor: { kind: 'before-class', pattern: 'x' }, markers: ['X'] }] };
  assert.throws(() => validateDescriptor(d), DescriptorValidationError);
});

test('validateDescriptor rejects a bootstrapAnchors marker starting with the reserved AI_IMPLEMENTATION namespace', () => {
  const d: Record<string, unknown> = { ...baseDescriptor(), bootstrapAnchors: [{ candidateFilenames: ['app.py'], anchor: { kind: 'after-line', pattern: 'x' }, markers: ['AI_IMPLEMENTATION_X'] }] };
  assert.throws(() => validateDescriptor(d), DescriptorValidationError);
});

// --- `_`-prefixed documentation fields (pack-author convention) ---
// The schema's strict `additionalProperties: false` rejects typos in known
// fields but allows any property whose name starts with `_` as a pack-
// author documentation allowance — the engine never reads them, so this is
// purely a documentation tolerance. Stores like `_comment`, `_notes`, or
// `_deprecated_at` are all permitted on every entry-level schema.

test('validateDescriptor accepts `_comment` on a targets[] entry alongside its real fields', () => {
  const d = { ...baseDescriptor(), targets: [{ output: 'src/x.cs', template: 'x.hbs', mode: 'create', _comment: 'this target is for the X feature' }] };
  assert.deepEqual(validateDescriptor(d), d);
});

test('validateDescriptor accepts multiple `_`-prefixed fields on a targets[] entry', () => {
  const d = {
    ...baseDescriptor(),
    targets: [{ output: 'src/x.cs', template: 'x.hbs', mode: 'create', _comment: 'first note', _notes: 'second note', _deprecated_at: '2026-01-01' }],
  };
  assert.deepEqual(validateDescriptor(d), d);
});

test('validateDescriptor accepts `_comment` on an injections[] entry alongside its real fields', () => {
  const d = {
    ...baseDescriptor(),
    injections: [{ file: 'Program.cs', marker: 'DI', template: 'di.hbs', position: 'before-end' as const, hashTrailerPrefix: '// scaffold-hash:', _comment: 'matches the marker in descriptor above' }],
  };
  assert.deepEqual(validateDescriptor(d), d);
});

test('validateDescriptor still rejects a non-underscored typo on a targets[] entry (typo detection is preserved)', () => {
  // `outpu` is a real typo (missing the trailing `t`) and must still fail
  // even with `_comment` present on the entry.
  const d: Record<string, unknown> = { ...baseDescriptor(), targets: [{ output: 'src/x.cs', template: 'x.hbs', mode: 'create', outpu: 'typo', _comment: 'ignored' }] };
  // The schema requires `output`, not `outpu`, so this fails with a
  // missing-property error rather than the additional-properties one.
  assert.throws(() => validateDescriptor(d), DescriptorValidationError);
});

test('validateDescriptor rejects a non-underscored unknown field on a targets[] entry', () => {
  const d: Record<string, unknown> = { ...baseDescriptor(), targets: [{ output: 'src/x.cs', template: 'x.hbs', mode: 'create', notes: 'no underscore prefix' }] };
  assert.throws(() => validateDescriptor(d), DescriptorValidationError);
});

test('validateDescriptor accepts `_comment` on a bootstrapAnchors[] entry', () => {
  const d = {
    ...baseDescriptor(),
    bootstrapAnchors: [{ candidateFilenames: ['app.py'], anchor: { kind: 'after-line', pattern: 'x' }, markers: ['X'], _comment: 'author notes' }],
  };
  assert.deepEqual(validateDescriptor(d), d);
});

test('validateDescriptor accepts `_comment` on an inputs[] entry', () => {
  const d = { ...baseDescriptor(), inputs: [{ name: 'aggregate', type: 'string', required: true, _comment: 'PascalCase per regex below' }] };
  assert.deepEqual(validateDescriptor(d), d);
});

test('validateDescriptor accepts artifact and when on targets and injections', () => {
  const descriptor = baseDescriptor();
  Object.assign(descriptor.targets[0], { artifact: 'op-create', when: { 'options.combine': false } });
  Object.assign(descriptor.injections[0], { artifact: 'op-create', when: { 'options.provider': 'aws' } });
  assert.deepEqual(validateDescriptor(descriptor), descriptor);
});

test('validateDescriptor rejects a non-kebab-case artifact tag', () => {
  const badTag = baseDescriptor();
  Object.assign(badTag.targets[0], { artifact: 'OpCreate' });
  assert.throws(() => validateDescriptor(badTag), DescriptorValidationError);

  const leadingDash = baseDescriptor();
  Object.assign(leadingDash.targets[0], { artifact: '-op' });
  assert.throws(() => validateDescriptor(leadingDash), DescriptorValidationError);
});

test('validateDescriptor rejects a when map that is empty or has non-scalar values', () => {
  const empty = baseDescriptor();
  Object.assign(empty.targets[0], { when: {} });
  assert.throws(() => validateDescriptor(empty), DescriptorValidationError);

  const nonScalar = baseDescriptor();
  Object.assign(nonScalar.targets[0], { when: { 'options.combine': { nested: true } } });
  assert.throws(() => validateDescriptor(nonScalar), DescriptorValidationError);
});

test('loadDescriptor reports a requires mismatch even when the descriptor also has unknown entry fields (version gate runs before shape validation)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-descriptor-'));
  const file = path.join(dir, 'manifest.templates.json');
  const futuristic = baseDescriptor();
  (futuristic.targets[0] as Record<string, unknown>).fieldFromTheFuture = 'new';
  writeFileSync(file, JSON.stringify(futuristic));
  // Old CLI (out of range): must get the version message, not a schema-error wall.
  assert.throws(() => loadDescriptor(file, '0.5.0'), DescriptorRequiresMismatchError);
  // In-range CLI: the unknown field is still a real schema failure.
  assert.throws(() => loadDescriptor(file, '1.2.3'), DescriptorValidationError);
});
