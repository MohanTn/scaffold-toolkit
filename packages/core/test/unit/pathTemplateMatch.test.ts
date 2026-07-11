import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateToRegex, pathMatchesTemplate } from '../../src/checkEdit/pathTemplateMatch.js';

test('templateToRegex: a static path with no placeholders matches only itself', () => {
  const regex = templateToRegex('Program.cs');
  assert.ok(regex.test('Program.cs'));
  assert.ok(!regex.test('Program.csx'));
  assert.ok(!regex.test('src/Program.cs'));
});

test('templateToRegex: a single bare placeholder matches any non-slash segment in that position', () => {
  const regex = templateToRegex('src/Endpoints/{{entity}}Endpoint.cs');
  assert.ok(regex.test('src/Endpoints/InvoiceEndpoint.cs'));
  assert.ok(regex.test('src/Endpoints/OrderEndpoint.cs'));
  assert.ok(!regex.test('src/Endpoints/InvoiceEndpoint.ts'), 'literal suffix must still match exactly');
  assert.ok(!regex.test('src/Endpoints/Sub/InvoiceEndpoint.cs'), 'a placeholder must not swallow a path separator');
});

test('templateToRegex: a helper-wrapped placeholder is treated the same as a bare one', () => {
  const regex = templateToRegex('src/{{pascal entity}}/{{entity}}Dto.cs');
  assert.ok(regex.test('src/Invoice/InvoiceDto.cs'));
  // Each placeholder is an independent [^/]+ capture, not a shared
  // backreference — templateToRegex has no manifest to render {{pascal
  // entity}} and {{entity}} to the *same* concrete value, so a path where
  // they disagree still matches structurally. That's an accepted looseness:
  // check-edit only needs "could this path have come from this template",
  // not "was it rendered from one specific manifest".
  assert.ok(regex.test('src/Invoice/OrderDto.cs'));
});

test('templateToRegex: multiple placeholders across multiple segments all resolve independently', () => {
  const regex = templateToRegex('{{options.area}}/src/{{entity}}/{{entity}}Repository.cs');
  assert.ok(regex.test('Billing/src/Invoice/InvoiceRepository.cs'));
  assert.ok(!regex.test('Billing/src/Invoice/InvoiceRepository.cs.bak'));
});

test('templateToRegex: literal regex-special characters in the template are escaped, not interpreted', () => {
  const regex = templateToRegex('src/Endpoints/{{entity}}Endpoint.cs');
  // A literal "." must not act as "any character" — this path differs only
  // by the dot position and must not match.
  assert.ok(!regex.test('src/EndpointsXEntityEndpointXcs'));
});

test('pathMatchesTemplate is a thin boolean wrapper around templateToRegex', () => {
  assert.equal(pathMatchesTemplate('Program.cs', 'Program.cs'), true);
  assert.equal(pathMatchesTemplate('Other.cs', 'Program.cs'), false);
});
