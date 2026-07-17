/**
 * Symlink-safe replacement for `import.meta.url === \`file://${process.argv[1]}\``.
 * Node resolves symlinks when loading an ES module, so `import.meta.url` is
 * already a realpath — but `process.argv[1]` is whatever path was typed on
 * the command line. Every hook here is actually invoked in production
 * through a symlinked path (dotfiles' `~/.claude/hooks/scaffold ->
 * .../adapter-claude-code`), so the un-normalized comparison never matches
 * and the entry point silently never runs main() at all. Resolving both
 * sides through realpathSync fixes the comparison regardless of topology:
 * direct invocation, symlinked invocation, or a relative path.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
