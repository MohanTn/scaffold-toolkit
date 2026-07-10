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
