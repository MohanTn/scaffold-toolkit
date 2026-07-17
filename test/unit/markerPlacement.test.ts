import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeMarkerGroup } from '../../src/bootstrapMarkers/markerPlacement.js';
import type { AnchorGroup } from '../../src/bootstrapMarkers/anchorCatalog.js';

const BUILDER_ZONE_GROUP: AnchorGroup = {
  candidateFilenames: ['Program.cs'],
  anchor: { kind: 'after-line', pattern: /\.CreateBuilder\s*\(/ },
  markers: ['GSM', 'DI', 'PUBSUB', 'SAGAS'],
};

const APP_ZONE_GROUP: AnchorGroup = {
  candidateFilenames: ['Program.cs'],
  anchor: { kind: 'after-line', pattern: /\.Build\s*\(\s*\)\s*;/ },
  markers: ['MIDDLEWARE', 'ROUTES'],
};

const DBSETS_GROUP: AnchorGroup = {
  candidateFilenames: ['AppDbContext.cs'],
  anchor: { kind: 'after-class-brace', declarationPattern: /\bclass\s+AppDbContext\b/ },
  markers: ['DBSETS'],
};

const REPOSITORIES_GROUP: AnchorGroup = {
  candidateFilenames: ['ApplicationServiceCollectionExtensions.cs'],
  anchor: { kind: 'after-class-brace', declarationPattern: /\bAddApplication\s*\(\s*this\s+IServiceCollection\s+services\s*\)/ },
  markers: ['REPOSITORIES'],
};

const PROGRAM_CS = `namespace Fixture;

public static class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        var app = builder.Build();

        app.Run();
    }
}
`;

const APP_DB_CONTEXT_CS = `namespace Fixture;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options)
    {
    }
}
`;

function lineIndexOf(content: string, text: string): number {
  return content
    .split('\n')
    .findIndex((l) => l.trim() === text);
}

test('placeMarkerGroup places an ordered contiguous block for an after-line anchor (GSM < DI < PUBSUB < SAGAS)', () => {
  const result = placeMarkerGroup('Program.cs', PROGRAM_CS, BUILDER_ZONE_GROUP);
  assert.ok(result.outcomes.every((o) => o.outcome === 'placed'));

  const gsm = lineIndexOf(result.content, '// SCAFFOLD:GSM:START');
  const di = lineIndexOf(result.content, '// SCAFFOLD:DI:START');
  const pubsub = lineIndexOf(result.content, '// SCAFFOLD:PUBSUB:START');
  const sagas = lineIndexOf(result.content, '// SCAFFOLD:SAGAS:START');
  assert.ok(gsm >= 0 && di > gsm && pubsub > di && sagas > pubsub);

  // Contiguous: each END immediately precedes the next marker's START.
  const lines = result.content.split('\n');
  assert.equal(lines[gsm + 1].trim(), '// SCAFFOLD:GSM:END');
  assert.equal(lines[gsm + 2].trim(), '// SCAFFOLD:DI:START');
  assert.equal(lines[di + 1].trim(), '// SCAFFOLD:DI:END');
  assert.equal(lines[di + 2].trim(), '// SCAFFOLD:PUBSUB:START');
});

test('placeMarkerGroup places MIDDLEWARE before ROUTES for the app-zone after-line anchor', () => {
  const result = placeMarkerGroup('Program.cs', PROGRAM_CS, APP_ZONE_GROUP);
  const middleware = lineIndexOf(result.content, '// SCAFFOLD:MIDDLEWARE:START');
  const routes = lineIndexOf(result.content, '// SCAFFOLD:ROUTES:START');
  assert.ok(middleware >= 0 && routes > middleware);
});

test('placeMarkerGroup falls back to needs-manual, content unchanged, when the after-line pattern matches zero times', () => {
  const content = 'no builder line here\n';
  const result = placeMarkerGroup('Program.cs', content, BUILDER_ZONE_GROUP);
  assert.ok(result.outcomes.every((o) => o.outcome === 'needs-manual'));
  assert.equal(result.content, content);
});

test('placeMarkerGroup falls back to needs-manual when the after-line pattern matches more than once', () => {
  const content = ['var builder = WebApplication.CreateBuilder(args);', 'var builder2 = WebApplication.CreateBuilder(args);'].join('\n');
  const result = placeMarkerGroup('Program.cs', content, BUILDER_ZONE_GROUP);
  assert.ok(result.outcomes.every((o) => o.outcome === 'needs-manual'));
  assert.equal(result.content, content);
});

test('placeMarkerGroup places DBSETS immediately after the class opening brace on a clean single-constructor fixture', () => {
  const result = placeMarkerGroup('AppDbContext.cs', APP_DB_CONTEXT_CS, DBSETS_GROUP);
  assert.equal(result.outcomes[0].outcome, 'placed');
  const lines = result.content.split('\n');
  const braceIdx = lines.findIndex((l) => l.trim() === '{');
  assert.equal(lines[braceIdx + 1].trim(), '// SCAFFOLD:DBSETS:START');
  assert.equal(lines[braceIdx + 2].trim(), '// SCAFFOLD:DBSETS:END');
});

test('placeMarkerGroup falls back to needs-manual when the class-brace declaration pattern matches zero times', () => {
  const content = 'public class SomethingElse\n{\n}\n';
  const result = placeMarkerGroup('AppDbContext.cs', content, DBSETS_GROUP);
  assert.equal(result.outcomes[0].outcome, 'needs-manual');
  assert.equal(result.content, content);
});

test('placeMarkerGroup falls back to needs-manual when the class-brace declaration pattern matches more than once', () => {
  const content = ['public class AppDbContext : DbContext', '{', '}', 'public class AppDbContext : OtherDbContext', '{', '}'].join('\n');
  const result = placeMarkerGroup('AppDbContext.cs', content, DBSETS_GROUP);
  assert.equal(result.outcomes[0].outcome, 'needs-manual');
  assert.equal(result.content, content);
});

test('placeMarkerGroup falls back to needs-manual when no unambiguous opening brace follows the declaration within the lookahead', () => {
  const content = [
    'public class AppDbContext : DbContext',
    '// comment 1',
    '// comment 2',
    '// comment 3',
    '// comment 4',
    '// comment 5',
    '{',
    '}',
  ].join('\n');
  const result = placeMarkerGroup('AppDbContext.cs', content, DBSETS_GROUP);
  assert.equal(result.outcomes[0].outcome, 'needs-manual');
  assert.equal(result.content, content);
});

test('an already-present marker mixed into the same group is left at its original location and not duplicated', () => {
  const content = [
    'namespace Fixture;',
    '',
    'public static class Program',
    '{',
    '    public static void Main(string[] args)',
    '    {',
    '        var builder = WebApplication.CreateBuilder(args);',
    '',
    '        // hand-moved DI marker, elsewhere in the file',
    '        // SCAFFOLD:DI:START',
    '        // SCAFFOLD:DI:END',
    '',
    '        var app = builder.Build();',
    '        app.Run();',
    '    }',
    '}',
    '',
  ].join('\n');

  const group: AnchorGroup = { candidateFilenames: ['Program.cs'], anchor: BUILDER_ZONE_GROUP.anchor, markers: ['GSM', 'DI'] };
  const result = placeMarkerGroup('Program.cs', content, group);

  const diOutcome = result.outcomes.find((o) => o.marker === 'DI')!;
  const gsmOutcome = result.outcomes.find((o) => o.marker === 'GSM')!;
  assert.equal(diOutcome.outcome, 'already-present');
  assert.equal(gsmOutcome.outcome, 'placed');

  const diStarts = result.content.split('\n').filter((l) => l.trim() === '// SCAFFOLD:DI:START');
  assert.equal(diStarts.length, 1, 'DI must not be duplicated');

  const lines = result.content.split('\n');
  const createBuilderIdx = lines.findIndex((l) => l.includes('CreateBuilder'));
  assert.equal(lines[createBuilderIdx + 1].trim(), '// SCAFFOLD:GSM:START');
  assert.equal(lines[createBuilderIdx + 2].trim(), '// SCAFFOLD:GSM:END');
});

test('content is returned byte-identical when no marker in the group was newly placed', () => {
  const content = [
    'var builder = WebApplication.CreateBuilder(args);',
    '// SCAFFOLD:GSM:START',
    '// SCAFFOLD:GSM:END',
    '// SCAFFOLD:DI:START',
    '// SCAFFOLD:DI:END',
  ].join('\n');
  const group: AnchorGroup = { candidateFilenames: ['Program.cs'], anchor: BUILDER_ZONE_GROUP.anchor, markers: ['GSM', 'DI'] };
  const result = placeMarkerGroup('Program.cs', content, group);
  assert.equal(result.content, content);
  assert.ok(result.outcomes.every((o) => o.outcome === 'already-present'));
});

test('a one-sided existing marker (START with no END) is reported needs-manual with a markerScan.ts-style file:line reason, content unchanged', () => {
  const content = ['var builder = WebApplication.CreateBuilder(args);', '// SCAFFOLD:DI:START'].join('\n');
  const group: AnchorGroup = { candidateFilenames: ['Program.cs'], anchor: BUILDER_ZONE_GROUP.anchor, markers: ['DI'] };
  const result = placeMarkerGroup('Program.cs', content, group);
  assert.equal(result.outcomes[0].outcome, 'needs-manual');
  assert.match(result.outcomes[0].reason!, /Program\.cs:2/);
  assert.match(result.outcomes[0].reason!, /one-sided/);
  assert.equal(result.content, content);
});

test('a duplicated existing START marker is reported needs-manual naming both line numbers, content unchanged', () => {
  const content = ['// SCAFFOLD:DI:START', '// SCAFFOLD:DI:START', 'content', '// SCAFFOLD:DI:END'].join('\n');
  const group: AnchorGroup = { candidateFilenames: ['Program.cs'], anchor: BUILDER_ZONE_GROUP.anchor, markers: ['DI'] };
  const result = placeMarkerGroup('Program.cs', content, group);
  assert.equal(result.outcomes[0].outcome, 'needs-manual');
  assert.match(result.outcomes[0].reason!, /Program\.cs:1,2/);
  assert.equal(result.content, content);
});

test('an untabled file extension marks every marker in the group needs-manual with the thrown message as reason, content unchanged', () => {
  const content = 'anything';
  const group: AnchorGroup = { candidateFilenames: ['Weird.razor'], anchor: BUILDER_ZONE_GROUP.anchor, markers: ['DI', 'GSM'] };
  const result = placeMarkerGroup('Weird.razor', content, group);
  assert.ok(result.outcomes.every((o) => o.outcome === 'needs-manual'));
  assert.match(result.outcomes[0].reason!, /Weird\.razor/);
  assert.equal(result.content, content);
});

// --- BUG 1 regression: K&R-style braces (opening brace on the declaration line itself) ---

const APP_DB_CONTEXT_CS_KR = `namespace Fixture;

public class AppDbContext : DbContext {
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) {
    }
}
`;

test('placeMarkerGroup places DBSETS directly under a K&R-style class declaration ("... : DbContext {"), not inside the constructor body', () => {
  const result = placeMarkerGroup('AppDbContext.cs', APP_DB_CONTEXT_CS_KR, DBSETS_GROUP);
  assert.equal(result.outcomes[0].outcome, 'placed');

  const lines = result.content.split('\n');
  const classDeclIdx = lines.findIndex((l) => l.includes('class AppDbContext'));
  assert.equal(lines[classDeclIdx + 1].trim(), '// SCAFFOLD:DBSETS:START');
  assert.equal(lines[classDeclIdx + 2].trim(), '// SCAFFOLD:DBSETS:END');

  // Must not have landed inside the constructor body instead.
  const ctorIdx = lines.findIndex((l) => l.includes('public AppDbContext('));
  assert.ok(ctorIdx > classDeclIdx + 2, 'the constructor must come after the placed block, not contain it');
});

const APPLICATION_SERVICE_COLLECTION_EXTENSIONS_CS_KR = `namespace Fixture.Application;

public static class ApplicationServiceCollectionExtensions {
    public static IServiceCollection AddApplication(this IServiceCollection services) {
        return services;
    }
}
`;

test('placeMarkerGroup places REPOSITORIES directly under a K&R-style AddApplication signature, not inside the method body', () => {
  const result = placeMarkerGroup('ApplicationServiceCollectionExtensions.cs', APPLICATION_SERVICE_COLLECTION_EXTENSIONS_CS_KR, REPOSITORIES_GROUP);
  assert.equal(result.outcomes[0].outcome, 'placed');

  const lines = result.content.split('\n');
  const methodDeclIdx = lines.findIndex((l) => l.includes('AddApplication'));
  assert.equal(lines[methodDeclIdx + 1].trim(), '// SCAFFOLD:REPOSITORIES:START');
  assert.equal(lines[methodDeclIdx + 2].trim(), '// SCAFFOLD:REPOSITORIES:END');

  const returnIdx = lines.findIndex((l) => l.trim() === 'return services;');
  assert.ok(returnIdx > methodDeclIdx + 2, 'the method body must come after the placed block, not contain it');
});

// --- BUG 3 regression: an ambiguous anchor must not downgrade a sibling marker that is already-present ---

test('an ambiguous/missing anchor only marks the markers that actually needed placement as needs-manual, leaving an already-present sibling marker untouched', () => {
  const content = [
    'var builder = WebApplication.CreateBuilder(args);',
    'var builder2 = WebApplication.CreateBuilder(args);', // duplicated anchor line -> builder-zone anchor is ambiguous
    '// SCAFFOLD:GSM:START',
    '// SCAFFOLD:GSM:END',
  ].join('\n');

  const group: AnchorGroup = { candidateFilenames: ['Program.cs'], anchor: BUILDER_ZONE_GROUP.anchor, markers: ['GSM', 'DI'] };
  const result = placeMarkerGroup('Program.cs', content, group);

  const gsmOutcome = result.outcomes.find((o) => o.marker === 'GSM')!;
  const diOutcome = result.outcomes.find((o) => o.marker === 'DI')!;
  assert.equal(gsmOutcome.outcome, 'already-present', 'GSM was already present and unrelated to the anchor ambiguity — must not be downgraded');
  assert.equal(diOutcome.outcome, 'needs-manual', 'DI actually needed placement, so it correctly falls back given the ambiguous anchor');
  assert.match(diOutcome.reason!, /expected exactly one/);
  assert.equal(result.content, content, 'nothing was newly placed, so content stays byte-identical');
});
