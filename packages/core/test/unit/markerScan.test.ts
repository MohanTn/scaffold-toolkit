import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanMarkers, scanAiImplementationBlocks, MarkerScanError } from '../../src/generate/markerScan.js';

const request = { marker: 'SCAFFOLD_DI', startLine: '// SCAFFOLD:SCAFFOLD_DI:START', endLine: '// SCAFFOLD:SCAFFOLD_DI:END' };

test('scanMarkers locates a valid single marker pair with correct offsets', () => {
  const content = ['line0', '// SCAFFOLD:SCAFFOLD_DI:START', 'line2', '// SCAFFOLD:SCAFFOLD_DI:END', 'line4'].join('\n');
  const result = scanMarkers('Program.cs', content, [request]);
  const location = result.get('SCAFFOLD_DI')!;
  assert.equal(location.startLineIndex, 1);
  assert.equal(location.endLineIndex, 3);
  assert.equal(content.slice(location.interiorStartOffset, location.interiorEndOffset), 'line2\n');
});

test('scanMarkers throws with file name when the marker is entirely missing', () => {
  const content = ['no markers here'].join('\n');
  assert.throws(() => scanMarkers('Program.cs', content, [request]), (err: unknown) => {
    assert.ok(err instanceof MarkerScanError);
    assert.match(err.message, /Program\.cs/);
    assert.match(err.message, /not found/);
    return true;
  });
});

test('scanMarkers throws citing the line number when the marker is one-sided (START with no END)', () => {
  const content = ['// SCAFFOLD:SCAFFOLD_DI:START', 'orphaned content'].join('\n');
  assert.throws(() => scanMarkers('Program.cs', content, [request]), (err: unknown) => {
    assert.ok(err instanceof MarkerScanError);
    assert.match(err.message, /Program\.cs:1/);
    assert.match(err.message, /one-sided/);
    return true;
  });
});

test('scanMarkers throws citing the line number when the marker is one-sided (END with no START)', () => {
  const content = ['orphaned content', '// SCAFFOLD:SCAFFOLD_DI:END'].join('\n');
  assert.throws(() => scanMarkers('Program.cs', content, [request]), (err: unknown) => {
    assert.ok(err instanceof MarkerScanError);
    assert.match(err.message, /Program\.cs:2/);
    return true;
  });
});

test('scanMarkers throws citing both line numbers when the START marker is duplicated', () => {
  const content = [
    '// SCAFFOLD:SCAFFOLD_DI:START',
    '// SCAFFOLD:SCAFFOLD_DI:START',
    'content',
    '// SCAFFOLD:SCAFFOLD_DI:END',
  ].join('\n');
  assert.throws(() => scanMarkers('Program.cs', content, [request]), (err: unknown) => {
    assert.ok(err instanceof MarkerScanError);
    assert.match(err.message, /Program\.cs:1,2/);
    assert.match(err.message, /twice|expected exactly once/);
    return true;
  });
});

test('scanMarkers scans two independent markers in one file without interference', () => {
  const content = [
    '// SCAFFOLD:SCAFFOLD_DI:START',
    'di content',
    '// SCAFFOLD:SCAFFOLD_DI:END',
    '// SCAFFOLD:SCAFFOLD_ROUTES:START',
    'route content',
    '// SCAFFOLD:SCAFFOLD_ROUTES:END',
  ].join('\n');
  const requests = [
    request,
    { marker: 'SCAFFOLD_ROUTES', startLine: '// SCAFFOLD:SCAFFOLD_ROUTES:START', endLine: '// SCAFFOLD:SCAFFOLD_ROUTES:END' },
  ];
  const result = scanMarkers('Program.cs', content, requests);
  assert.equal(result.size, 2);
  assert.equal(result.get('SCAFFOLD_DI')!.startLineIndex, 0);
  assert.equal(result.get('SCAFFOLD_ROUTES')!.startLineIndex, 3);
});

test('scanAiImplementationBlocks finds an empty block and reports its content', () => {
  const content = ['before', '// AI_IMPLEMENTATION_START', '// AI_IMPLEMENTATION_END', 'after'].join('\n');
  const blocks = scanAiImplementationBlocks('Endpoint.cs', content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].empty, true);
  assert.equal(blocks[0].startLine, 1);
  assert.equal(blocks[0].endLine, 2);
});

test('scanAiImplementationBlocks reports non-empty content as not empty', () => {
  const content = ['// AI_IMPLEMENTATION_START', '  return 42;', '// AI_IMPLEMENTATION_END'].join('\n');
  const blocks = scanAiImplementationBlocks('Endpoint.cs', content);
  assert.equal(blocks[0].empty, false);
  assert.equal(blocks[0].content, '  return 42;');
});
