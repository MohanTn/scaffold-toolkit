import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarkerSyntax } from '../../src/generate/commentSyntax.js';

test('resolveMarkerSyntax uses // for .cs files', () => {
  const syntax = resolveMarkerSyntax('Program.cs', 'SCAFFOLD_DI');
  assert.equal(syntax.startLine, '// SCAFFOLD:SCAFFOLD_DI:START');
  assert.equal(syntax.endLine, '// SCAFFOLD:SCAFFOLD_DI:END');
});

test('resolveMarkerSyntax uses # for .py files', () => {
  const syntax = resolveMarkerSyntax('app.py', 'SCAFFOLD_ROUTES');
  assert.equal(syntax.startLine, '# SCAFFOLD:SCAFFOLD_ROUTES:START');
  assert.equal(syntax.endLine, '# SCAFFOLD:SCAFFOLD_ROUTES:END');
});

test('resolveMarkerSyntax uses HTML comments for .html files', () => {
  const syntax = resolveMarkerSyntax('index.html', 'SCAFFOLD_HEAD');
  assert.equal(syntax.startLine, '<!-- SCAFFOLD:SCAFFOLD_HEAD:START -->');
  assert.equal(syntax.endLine, '<!-- SCAFFOLD:SCAFFOLD_HEAD:END -->');
});

test('resolveMarkerSyntax throws naming the file for an extension with no table entry and no override', () => {
  assert.throws(() => resolveMarkerSyntax('Weird.razor', 'SCAFFOLD_DI'), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Weird\.razor/);
    return true;
  });
});

test('resolveMarkerSyntax uses an explicit override instead of the table, even for a known extension', () => {
  const syntax = resolveMarkerSyntax('Weird.razor', 'SCAFFOLD_DI', { start: '@* SCAFFOLD:SCAFFOLD_DI:START *@', end: '@* SCAFFOLD:SCAFFOLD_DI:END *@' });
  assert.equal(syntax.startLine, '@* SCAFFOLD:SCAFFOLD_DI:START *@');
});

// --- Pack-level commentSyntax map (axis 2) ---

test('resolveMarkerSyntax uses a pack-level {prefix} entry for an unlisted extension', () => {
  const syntax = resolveMarkerSyntax('schema.sql', 'MIGRATIONS', undefined, { '.sql': { prefix: '--' } });
  assert.equal(syntax.startLine, '-- SCAFFOLD:MIGRATIONS:START');
  assert.equal(syntax.endLine, '-- SCAFFOLD:MIGRATIONS:END');
});

test('resolveMarkerSyntax uses a pack-level {wrap} entry for an unlisted extension', () => {
  const syntax = resolveMarkerSyntax('view.razor', 'BODY', undefined, { '.razor': { wrap: ['@* ', ' *@'] } });
  assert.equal(syntax.startLine, '@* SCAFFOLD:BODY:START *@');
  assert.equal(syntax.endLine, '@* SCAFFOLD:BODY:END *@');
});

test('resolveMarkerSyntax precedence: per-injection override > pack map > built-in table', () => {
  const packMap = { '.sql': { prefix: '--' } };
  const override = { start: 'REM SCAFFOLD:X:START', end: 'REM SCAFFOLD:X:END' };
  const syntax = resolveMarkerSyntax('schema.sql', 'X', override, packMap);
  assert.equal(syntax.startLine, 'REM SCAFFOLD:X:START');
});

test('resolveMarkerSyntax precedence: pack map beats built-in table for an extension that\'s both declared and built-in', () => {
  const packMap = { '.py': { prefix: '# py-pack:' } };
  const syntax = resolveMarkerSyntax('app.py', 'X', undefined, packMap);
  assert.equal(syntax.startLine, '# py-pack: SCAFFOLD:X:START');
});

test('resolveMarkerSyntax still throws for an unlisted extension with no pack map entry', () => {
  assert.throws(() => resolveMarkerSyntax('Weird.unknownext', 'X', undefined, { '.sql': { prefix: '--' } }), /Weird\.unknownext/);
});

test('resolveMarkerSyntax ignores pack map entries whose keys don\'t match the file extension', () => {
  // No .swift key in pack map → fall through to built-in TABLE, also fails → throw.
  const packMap = { '.sql': { prefix: '--' } };
  assert.throws(() => resolveMarkerSyntax('hello.swift', 'X', undefined, packMap), /hello\.swift/);
});

test('resolveMarkerSyntax falls through to a pack map .other entry without using it (only the file extension key is checked)', () => {
  // An extension that's in the built-in table like .py with no pack map entry
  // falls through to the built-in table — pack-map keys do not match by suffix.
  const syntax = resolveMarkerSyntax('app.py', 'X', undefined, { '.sql': { prefix: '--' } });
  assert.equal(syntax.startLine, '# SCAFFOLD:X:START');
  assert.equal(syntax.endLine, '# SCAFFOLD:X:END');
});
