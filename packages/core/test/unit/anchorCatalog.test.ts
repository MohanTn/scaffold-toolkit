import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_CATALOG, assertValidMarkerId, validateCatalog, compileBootstrapAnchors } from '../../src/bootstrapMarkers/anchorCatalog.js';
import type { AnchorGroup } from '../../src/bootstrapMarkers/anchorCatalog.js';

test('assertValidMarkerId passes for every marker in every catalog group', () => {
  for (const groups of Object.values(ANCHOR_CATALOG)) {
    for (const group of groups) {
      for (const marker of group.markers) {
        assert.doesNotThrow(() => assertValidMarkerId(marker));
      }
    }
  }
});

test('assertValidMarkerId throws on an AI_IMPLEMENTATION-prefixed marker', () => {
  assert.throws(() => assertValidMarkerId('AI_IMPLEMENTATION'), /reserved/);
  assert.throws(() => assertValidMarkerId('AI_IMPLEMENTATION_FOO'), /reserved/);
});

// --- BUG 5 regression: assertValidMarkerId must be a real runtime guard, not just something the catalog's own unit test happens to call ---

test('ANCHOR_CATALOG itself passes validateCatalog (proves the real catalog module loads cleanly, i.e. it already passed this check at import time)', () => {
  assert.doesNotThrow(() => validateCatalog(ANCHOR_CATALOG));
});

test('validateCatalog throws when a catalog entry carries an AI_IMPLEMENTATION-prefixed marker, the same check anchorCatalog.ts runs against the real ANCHOR_CATALOG at module load', () => {
  const badGroup: AnchorGroup = {
    candidateFilenames: ['Program.cs'],
    anchor: { kind: 'after-line', pattern: /\.CreateBuilder\s*\(/ },
    markers: ['AI_IMPLEMENTATION_SOMETHING'],
  };
  const badCatalog: Record<string, AnchorGroup[]> = { 'fake-version': [badGroup] };
  assert.throws(() => validateCatalog(badCatalog), /reserved/);
});

// ".CreateBuilder" and ".Build" both contain the substring "Build", so
// distinguishing zones by regex source must anchor on the leading "Create"
// rather than testing plain substring inclusion.
function isBuilderZonePattern(pattern: RegExp): boolean {
  return pattern.source.includes('CreateBuilder');
}
function isAppZonePattern(pattern: RegExp): boolean {
  return pattern.source.includes('Build') && !pattern.source.includes('CreateBuilder');
}

function builderZoneMarkers(version: keyof typeof ANCHOR_CATALOG): string[] {
  const group = ANCHOR_CATALOG[version].find((g) => g.candidateFilenames.includes('Program.cs') && g.anchor.kind === 'after-line' && isBuilderZonePattern((g.anchor as { pattern: RegExp }).pattern));
  assert.ok(group, `no builder-zone group found for ${version}`);
  return group!.markers;
}

test('the builder-zone group markers are exactly [GSM, DI, PUBSUB, SAGAS] for both GCP versions, in that order', () => {
  assert.deepEqual(builderZoneMarkers('v8-controller-gcp'), ['GSM', 'DI', 'PUBSUB', 'SAGAS']);
  assert.deepEqual(builderZoneMarkers('v10-minimal-api-gcp'), ['GSM', 'DI', 'PUBSUB', 'SAGAS']);
});

test('v8-controller and v8-controller-gcp have no app-zone group (no .Build() anchor)', () => {
  for (const version of ['v8-controller', 'v8-controller-gcp'] as const) {
    const hasAppZone = ANCHOR_CATALOG[version].some((g) => g.anchor.kind === 'after-line' && isAppZonePattern((g.anchor as { pattern: RegExp }).pattern));
    assert.equal(hasAppZone, false, `${version} should have no app-zone group`);
  }
});

test('non-GCP versions never mention GSM, PUBSUB, or SAGAS anywhere', () => {
  for (const version of ['v8-controller', 'v10-minimal-api'] as const) {
    const allMarkers = ANCHOR_CATALOG[version].flatMap((g) => g.markers);
    assert.equal(allMarkers.includes('GSM'), false);
    assert.equal(allMarkers.includes('PUBSUB'), false);
    assert.equal(allMarkers.includes('SAGAS'), false);
  }
});

test('every version has DBSETS on AppDbContext.cs and REPOSITORIES on ApplicationServiceCollectionExtensions.cs', () => {
  for (const groups of Object.values(ANCHOR_CATALOG)) {
    const dbsets = groups.find((g) => g.markers.includes('DBSETS'));
    const repositories = groups.find((g) => g.markers.includes('REPOSITORIES'));
    assert.ok(dbsets, 'missing DBSETS group');
    assert.deepEqual(dbsets!.candidateFilenames, ['AppDbContext.cs']);
    assert.equal(dbsets!.anchor.kind, 'after-class-brace');
    assert.ok(repositories, 'missing REPOSITORIES group');
    assert.deepEqual(repositories!.candidateFilenames, ['ApplicationServiceCollectionExtensions.cs']);
    assert.equal(repositories!.anchor.kind, 'after-class-brace');
  }
});

test('v10-minimal-api and v10-minimal-api-gcp have an app-zone group with markers [MIDDLEWARE, ROUTES] in that order', () => {
  for (const version of ['v10-minimal-api', 'v10-minimal-api-gcp'] as const) {
    const appZone = ANCHOR_CATALOG[version].find(
      (g) => g.anchor.kind === 'after-line' && isAppZonePattern((g.anchor as { pattern: RegExp }).pattern),
    );
    assert.ok(appZone, `${version} should have an app-zone group`);
    assert.deepEqual(appZone!.markers, ['MIDDLEWARE', 'ROUTES']);
  }
});

// --- compileBootstrapAnchors (axis 3 of the pack-driven plan) ---

test('compileBootstrapAnchors turns a string after-line pattern into a working RegExp', () => {
  const compiled = compileBootstrapAnchors([{ candidateFilenames: ['app.py'], anchor: { kind: 'after-line', pattern: '\\bdef\\s+main\\b' }, markers: ['REGISTRY'] }]);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].anchor.kind, 'after-line');
  assert.ok((compiled[0].anchor as { pattern: RegExp }).pattern instanceof RegExp);
  assert.ok((compiled[0].anchor as { pattern: RegExp }).pattern.test('def main():'));
  assert.equal(compiled[0].markers[0], 'REGISTRY');
});

test('compileBootstrapAnchors turns a string after-class-brace declarationPattern into a working RegExp', () => {
  const compiled = compileBootstrapAnchors([{ candidateFilenames: ['models.py'], anchor: { kind: 'after-class-brace', declarationPattern: '\\bclass\\s+Order\\b' }, markers: ['REPO'] }]);
  assert.equal(compiled[0].anchor.kind, 'after-class-brace');
  assert.ok((compiled[0].anchor as { declarationPattern: RegExp }).declarationPattern instanceof RegExp);
  assert.ok((compiled[0].anchor as { declarationPattern: RegExp }).declarationPattern.test('class Order(BaseModel):'));
});

test('compileBootstrapAnchors runs the reserved-namespace guard on every marker', () => {
  assert.throws(() => compileBootstrapAnchors([
    { candidateFilenames: ['app.py'], anchor: { kind: 'after-line', pattern: 'x' }, markers: ['AI_IMPLEMENTATION_X'] },
  ]), /reserved/);
});

test('compileBootstrapAnchors throws on a malformed (invalid RegExp source) pattern', () => {
  assert.throws(() => compileBootstrapAnchors([
    { candidateFilenames: ['app.py'], anchor: { kind: 'after-line', pattern: '[invalid' }, markers: ['X'] },
  ]), /not a valid RegExp/);
});

test('compileBootstrapAnchors throws on an unknown anchor kind', () => {
  assert.throws(() => compileBootstrapAnchors([
    { candidateFilenames: ['app.py'], anchor: { kind: 'before-class', pattern: 'x' }, markers: ['X'] },
  ]), /after-line|after-class-brace/);
});

test('compileBootstrapAnchors returns an empty array for an empty input array', () => {
  assert.deepEqual(compileBootstrapAnchors([]), []);
});
