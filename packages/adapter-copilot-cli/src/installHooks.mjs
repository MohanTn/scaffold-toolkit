/**
 * `gh scaffold install-hooks`: writes a repo-level Copilot CLI hooks config
 * (`.github/hooks/scaffold-toolkit.json`) pointing at this package's own
 * `preToolUse`/`postToolUse`/`agentStop` scripts, by absolute path.
 *
 * Repo-level (not `~/.copilot/hooks/`) is the deliberate default: it's
 * committed to the repo and applies to every teammate using Copilot CLI
 * there automatically, the same one-time-per-repo model the Claude Code
 * adapter's SKILL.md uses when it merges hook entries into a target repo's
 * `.claude/settings.json`.
 *
 * `preToolUse` is the hard gate (mirrors the Claude Code adapter's
 * PreToolUse hook) — see hooks/pre-tool-use.mjs's own header comment for
 * the *** VERIFY BEFORE SHIP — HIGH RISK *** caveat on its guessed
 * toolName/toolArgs field shape. `postToolUse`/`agentStop` are unchanged.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(HERE, '..', 'hooks');

/**
 * Resolves the absolute paths to this package's own hook scripts. Throws if
 * they're missing — a half-installed adapter should not silently write a
 * hooks config that points at nothing.
 *
 * @returns {{ preToolUse: string, postToolUse: string, agentStop: string }}
 */
export function resolveHookScriptPaths() {
  const preToolUse = path.join(HOOKS_DIR, 'pre-tool-use.mjs');
  const postToolUse = path.join(HOOKS_DIR, 'post-tool-use.mjs');
  const agentStop = path.join(HOOKS_DIR, 'agent-stop.mjs');
  if (!existsSync(preToolUse) || !existsSync(postToolUse) || !existsSync(agentStop)) {
    throw new Error(`scaffold-adapter-copilot-cli's own hook scripts are missing under ${HOOKS_DIR} — reinstall the package`);
  }
  return { preToolUse, postToolUse, agentStop };
}

/**
 * Builds the Copilot CLI hooks JSON config (schema per
 * https://docs.github.com/en/copilot/reference/hooks-reference): a
 * `preToolUse` hard gate, a `postToolUse` soft nudge, and an `agentStop`
 * hard block, all `command`-type hooks running `node <absolute-script-path>`.
 *
 * @param {{ preToolUse: string, postToolUse: string, agentStop: string }} scriptPaths
 * @returns {object}
 */
export function buildHooksConfig(scriptPaths) {
  return {
    version: 1,
    hooks: {
      preToolUse: [{ type: 'command', bash: `node "${scriptPaths.preToolUse}"`, timeoutSec: 15 }],
      postToolUse: [{ type: 'command', bash: `node "${scriptPaths.postToolUse}"`, timeoutSec: 15 }],
      agentStop: [{ type: 'command', bash: `node "${scriptPaths.agentStop}"`, timeoutSec: 15 }],
    },
  };
}

/**
 * Writes the hooks config into `<targetRepoRoot>/.github/hooks/scaffold-toolkit.json`.
 * Deterministic overwrite (same pattern as `scaffold init` writing
 * `.scaffold/config.json`) — re-running after a package upgrade refreshes
 * the absolute script paths without requiring manual cleanup first.
 *
 * @param {string} targetRepoRoot
 * @returns {string} the config file's absolute path
 */
export function installHooks(targetRepoRoot) {
  const scriptPaths = resolveHookScriptPaths();
  const config = buildHooksConfig(scriptPaths);
  const hooksDir = path.join(targetRepoRoot, '.github', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const configPath = path.join(hooksDir, 'scaffold-toolkit.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}
