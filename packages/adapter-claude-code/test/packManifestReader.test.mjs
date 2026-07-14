import { test } from 'node:test';
import assert from 'node:assert';
import {
  mapFileToTemplate,
  getStandardsForFile,
  formatStandardsGuidance,
} from '../hooks/packManifestReader.mjs';

test('mapFileToTemplate: exact pattern match', () => {
  const manifest = {
    targets: [
      { output: '{{entity}}Repository.cs', template: 'EntityRepository.cs.hbs' },
      { output: 'Create{{entity}}Command.cs', template: 'CreateEntityCommand.cs.hbs' },
    ],
  };

  const result = mapFileToTemplate('OrderRepository.cs', manifest);
  assert.strictEqual(result, 'EntityRepository.cs.hbs');
});

test('mapFileToTemplate: returns null when no match', () => {
  const manifest = {
    targets: [
      { output: '{{entity}}Repository.cs', template: 'EntityRepository.cs.hbs' },
    ],
  };

  const result = mapFileToTemplate('SomeRandomFile.txt', manifest);
  assert.strictEqual(result, null);
});

test('mapFileToTemplate: prefers more specific matches', () => {
  const manifest = {
    targets: [
      { output: '{{entity}}Handler.cs', template: 'GenericHandler.cs.hbs' },
      { output: 'Create{{entity}}CommandHandler.cs', template: 'CreateEntityCommandHandler.cs.hbs' },
    ],
  };

  const result = mapFileToTemplate('CreateOrderCommandHandler.cs', manifest);
  // Should prefer the more specific pattern (fewer {{ }})
  assert.strictEqual(result, 'CreateEntityCommandHandler.cs.hbs');
});

test('getStandardsForFile: exact template match', () => {
  const manifest = {
    codingStandards: {
      'EntityRepository.cs.hbs': {
        fileType: 'repository',
        rules: ['Use transactions', 'Use using blocks'],
      },
    },
    targets: [
      { output: '{{entity}}Repository.cs', template: 'EntityRepository.cs.hbs' },
    ],
  };

  const result = getStandardsForFile('OrderRepository.cs', manifest);
  // getStandardsForFile should find the standards by mapping OrderRepository.cs to EntityRepository.cs.hbs template
  assert.ok(result, 'Should find standards for OrderRepository.cs');
  assert.strictEqual(result.fileType, 'repository');
  assert.strictEqual(result.rules.length, 2);
  assert.strictEqual(result.rules[0], 'Use transactions');
});

test('getStandardsForFile: returns null when no match', () => {
  const manifest = {
    codingStandards: {
      'EntityRepository.cs.hbs': { fileType: 'repository', rules: [] },
    },
  };

  const result = getStandardsForFile('UnknownFile.cs', manifest);
  assert.strictEqual(result, null);
});

test('getStandardsForFile: pattern match with wildcard', () => {
  const manifest = {
    codingStandards: {
      '*Handler.cs': {
        fileType: 'handler',
        rules: ['Validate before load', 'Return explicit Result<T>'],
      },
    },
  };

  const result = getStandardsForFile('CreateOrderHandler.cs', manifest);
  assert.ok(result, 'Should match *Handler.cs pattern');
  assert.strictEqual(result.fileType, 'handler');
});

test('getStandardsForFile: missing codingStandards field returns null', () => {
  const manifest = {
    targets: [{ output: '{{entity}}Handler.cs', template: 'Handler.hbs' }],
    // No codingStandards field
  };

  const result = getStandardsForFile('OrderHandler.cs', manifest);
  assert.strictEqual(result, null);
});

test('formatStandardsGuidance: formats guidance string with rules', () => {
  const standards = {
    fileType: 'handler',
    rules: ['Decompose >150 LOC', 'Validate before load', 'Use async/await'],
  };

  const result = formatStandardsGuidance(standards, 'CreateOrderHandler.cs');
  assert.ok(result.includes('Coding standards for handler'));
  assert.ok(result.includes('CreateOrderHandler.cs'));
  assert.ok(result.includes('Decompose >150 LOC'));
  assert.ok(result.includes('Validate before load'));
  assert.ok(result.includes('class-level AI_IMPLEMENTATION marker'));
});

test('formatStandardsGuidance: includes block line range when provided', () => {
  const standards = { fileType: 'repository', rules: ['Use transactions'] };
  const blockLines = { start: 10, end: 25 };

  const result = formatStandardsGuidance(standards, 'OrderRepository.cs', blockLines);
  assert.ok(result.includes('lines 10-25'));
});

test('formatStandardsGuidance: handles missing rules gracefully', () => {
  const standards = { fileType: 'dto' };
  const result = formatStandardsGuidance(standards, 'OrderDto.cs');
  assert.ok(result.includes('Coding standards for dto'));
});
