import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCreationGate, ManifestCreationGateError } from '../../src/generate/creationGate.js';
import type { CreationGateTarget } from '../../src/generate/creationGate.js';

test('checkCreationGate: no throw when overwrite target has existedBefore: true', () => {
  const targets: CreationGateTarget[] = [
    { relPath: 'src/Endpoints/UserEndpoint.cs', mode: 'overwrite', existedBefore: true },
  ];
  assert.doesNotThrow(() => {
    checkCreationGate(targets);
  });
});

test('checkCreationGate: no throw for create target regardless of existedBefore', () => {
  const targets: CreationGateTarget[] = [
    { relPath: 'src/Endpoints/UserEndpoint.cs', mode: 'create', existedBefore: false },
  ];
  assert.doesNotThrow(() => {
    checkCreationGate(targets);
  });
});

test('checkCreationGate: no throw for skip-if-exists target regardless of existedBefore', () => {
  const targets: CreationGateTarget[] = [
    { relPath: 'src/Endpoints/UserEndpoint.cs', mode: 'skip-if-exists', existedBefore: false },
    { relPath: 'src/Endpoints/ProductEndpoint.cs', mode: 'skip-if-exists', existedBefore: true },
  ];
  assert.doesNotThrow(() => {
    checkCreationGate(targets);
  });
});

test('checkCreationGate: throws ManifestCreationGateError when overwrite target has existedBefore: false', () => {
  const targets: CreationGateTarget[] = [
    { relPath: 'src/Endpoints/UserEndpoint.cs', mode: 'overwrite', existedBefore: false },
  ];
  assert.throws(
    () => {
      checkCreationGate(targets);
    },
    ManifestCreationGateError,
  );
});

test('checkCreationGate: error message includes the missing overwrite target path', () => {
  const targets: CreationGateTarget[] = [
    { relPath: 'src/Endpoints/UserEndpoint.cs', mode: 'overwrite', existedBefore: false },
  ];
  try {
    checkCreationGate(targets);
    assert.fail('expected checkCreationGate to throw');
  } catch (error) {
    assert.ok(error instanceof ManifestCreationGateError);
    assert.match(error.message, /src\/Endpoints\/UserEndpoint\.cs/);
    assert.match(error.message, /does not exist and its target mode is "overwrite"/);
  }
});

test('checkCreationGate: batched violations — multiple missing overwrite targets produce one error naming all paths', () => {
  const targets: CreationGateTarget[] = [
    { relPath: 'src/Endpoints/UserEndpoint.cs', mode: 'overwrite', existedBefore: false },
    { relPath: 'src/Services/UserService.cs', mode: 'overwrite', existedBefore: false },
    { relPath: 'src/Controllers/UserController.cs', mode: 'create', existedBefore: false }, // create is OK
  ];
  try {
    checkCreationGate(targets);
    assert.fail('expected checkCreationGate to throw');
  } catch (error) {
    assert.ok(error instanceof ManifestCreationGateError);
    assert.equal(error.violations.length, 2);
    assert.match(error.message, /src\/Endpoints\/UserEndpoint\.cs/);
    assert.match(error.message, /src\/Services\/UserService\.cs/);
  }
});

test('checkCreationGate: toPosixRelPath converts backslash Windows paths to forward slashes', () => {
  const targets: CreationGateTarget[] = [
    { relPath: 'src\\Endpoints\\UserEndpoint.cs', mode: 'overwrite', existedBefore: false },
  ];
  try {
    checkCreationGate(targets);
    assert.fail('expected checkCreationGate to throw');
  } catch (error) {
    assert.ok(error instanceof ManifestCreationGateError);
    // The error message should have forward slashes, not backslashes
    assert.match(error.message, /src\/Endpoints\/UserEndpoint\.cs/);
    assert.doesNotMatch(error.message, /\\/);
  }
});

test('checkCreationGate: no throw when overwrite target exists and create target does not', () => {
  const targets: CreationGateTarget[] = [
    { relPath: 'src/Endpoints/UserEndpoint.cs', mode: 'overwrite', existedBefore: true },
    { relPath: 'src/Endpoints/ProductEndpoint.cs', mode: 'create', existedBefore: false },
  ];
  assert.doesNotThrow(() => {
    checkCreationGate(targets);
  });
});
