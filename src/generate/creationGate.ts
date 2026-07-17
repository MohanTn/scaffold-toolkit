/**
 * Gate that prevents `scaffold generate` from writing an `overwrite`-mode
 * target that doesn't already exist on disk. The gate runs before any
 * rendering and before the dryRun short-circuit, ensuring the manifest
 * is valid before any side effects.
 *
 * `overwrite` targets may only replace a file that already exists, not
 * create one — a new file must be scaffolded via a "create" or
 * "skip-if-exists" target first. This prevents accidental data loss when
 * a pack descriptor and the target repo get out of sync.
 */

import type { DescriptorTarget } from '../descriptor/schema.js';

export interface CreationGateTarget {
  relPath: string;
  mode: DescriptorTarget['mode'];
  existedBefore: boolean;
}

export interface CreationGateViolation {
  relPath: string;
}

export class ManifestCreationGateError extends Error {
  constructor(public readonly violations: CreationGateViolation[]) {
    const lines = violations.map(
      (v) =>
        `${v.relPath} does not exist and its target mode is "overwrite" — overwrite targets may only replace a file that already exists, not create one; add it via a "create"/"skip-if-exists" target first, or fix the pack descriptor`,
    );
    super(lines.join('\n'));
    this.name = 'ManifestCreationGateError';
  }
}

/**
 * Convert backslashes to forward slashes for consistent path display.
 * No-op on POSIX systems where paths are already using forward slashes.
 */
function toPosixRelPath(windowsOrPosixPath: string): string {
  return windowsOrPosixPath.replace(/\\/g, '/');
}

/**
 * Check that all `overwrite`-mode targets already exist on disk.
 * Throws `ManifestCreationGateError` if any violation is found.
 * No I/O — caller supplies `existedBefore` for each target.
 */
export function checkCreationGate(targets: CreationGateTarget[]): void {
  const violations: CreationGateViolation[] = [];

  for (const target of targets) {
    // Gate only applies to overwrite-mode targets that didn't exist before
    if (target.mode === 'overwrite' && !target.existedBefore) {
      violations.push({ relPath: toPosixRelPath(target.relPath) });
    }
  }

  if (violations.length > 0) {
    throw new ManifestCreationGateError(violations);
  }
}
