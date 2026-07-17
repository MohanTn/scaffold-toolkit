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

test('scanAiImplementationBlocks also matches the colon form SCAFFOLD:AI_IMPLEMENTATION:START/END used by the dotnet packs', () => {
  const content = [
    'public async Task Handle()',
    '{',
    '    // SCAFFOLD:AI_IMPLEMENTATION:START',
    '    var entity = await _repository.GetByIdAsync(id, ct);',
    '    // SCAFFOLD:AI_IMPLEMENTATION:END',
    '}',
  ].join('\n');
  const blocks = scanAiImplementationBlocks('InvoiceService.cs', content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].empty, false);
  assert.match(blocks[0].content, /GetByIdAsync/);
});

test('scanAiImplementationBlocks marks a block required when its START carries the reserved :required token, in both spellings', () => {
  const react = ['// AI_IMPLEMENTATION_START:required', '  return derive();', '// AI_IMPLEMENTATION_END'].join('\n');
  const dotnet = ['// SCAFFOLD:AI_IMPLEMENTATION:START:required', '  var x = 1;', '// SCAFFOLD:AI_IMPLEMENTATION:END'].join('\n');
  assert.equal(scanAiImplementationBlocks('hooks.ts', react)[0].required, true);
  assert.equal(scanAiImplementationBlocks('Service.cs', dotnet)[0].required, true);
});

test('scanAiImplementationBlocks: an untagged block is not required, and the required token is a flag not a pairing id (END may stay plain)', () => {
  const untagged = ['// AI_IMPLEMENTATION_START', '  x', '// AI_IMPLEMENTATION_END'].join('\n');
  assert.equal(scanAiImplementationBlocks('f.ts', untagged)[0].required, false);
  // START tagged :required, END plain — must still pair without a mismatch throw.
  const startOnly = ['// AI_IMPLEMENTATION_START:required', '  x', '// AI_IMPLEMENTATION_END'].join('\n');
  const blocks = scanAiImplementationBlocks('f.ts', startOnly);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].required, true);
  assert.equal(blocks[0].id, undefined, 'the required flag is not surfaced as a pairing id');
});

test('scanAiImplementationBlocks still enforces genuine id pairing (a non-required id must match)', () => {
  const mismatched = ['// AI_IMPLEMENTATION_START:one', '  x', '// AI_IMPLEMENTATION_END:two'].join('\n');
  assert.throws(() => scanAiImplementationBlocks('f.ts', mismatched), /does not match START id/);
});

test('scanAiImplementationBlocks reports interior offsets that slice out exactly the block content, mirroring MarkerLocation', () => {
  const content = ['before', '// AI_IMPLEMENTATION_START', '  return 42;', '// AI_IMPLEMENTATION_END', 'after'].join('\n');
  const blocks = scanAiImplementationBlocks('Endpoint.cs', content);
  const block = blocks[0];
  assert.equal(content.slice(block.interiorStartOffset, block.interiorEndOffset), '  return 42;\n');
});

test('scanAiImplementationBlocks reports zero-width interior offsets for an empty block', () => {
  const content = ['// AI_IMPLEMENTATION_START', '// AI_IMPLEMENTATION_END'].join('\n');
  const blocks = scanAiImplementationBlocks('Endpoint.cs', content);
  const block = blocks[0];
  assert.equal(block.interiorStartOffset, block.interiorEndOffset);
  assert.equal(content.slice(block.interiorStartOffset, block.interiorEndOffset), '');
});

test('scanAiImplementationBlocks computes independent interior offsets for two blocks in one file', () => {
  const content = [
    '// AI_IMPLEMENTATION_START:one',
    '  first',
    '// AI_IMPLEMENTATION_END:one',
    'middle',
    '// AI_IMPLEMENTATION_START:two',
    '  second',
    '// AI_IMPLEMENTATION_END:two',
  ].join('\n');
  const blocks = scanAiImplementationBlocks('f.ts', content);
  assert.equal(blocks.length, 2);
  assert.equal(content.slice(blocks[0].interiorStartOffset, blocks[0].interiorEndOffset), '  first\n');
  assert.equal(content.slice(blocks[1].interiorStartOffset, blocks[1].interiorEndOffset), '  second\n');
  assert.ok(blocks[1].interiorStartOffset > blocks[0].interiorEndOffset, 'the second block\'s interior must start after the first block ends');
});
