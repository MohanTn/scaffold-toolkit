#!/usr/bin/env node
/**
 * sessionStart hook for GitHub Copilot CLI: the Copilot counterpart of the
 * Claude Code adapter's user-prompt-submit.mjs. No `execFileSync` at all —
 * just an `existsSync` check on `.scaffold/config.json` — because this hook
 * is a complementary early-warning layer, not the enforcement itself. The
 * real, un-skippable gate is preToolUse (pre-tool-use.mjs), which actually
 * blocks a disallowed write/edit; this hook only injects a standing
 * instruction into context, unconditional on any prompt content. Its
 * purpose is to make the preToolUse block, if the agent hits one,
 * unsurprising — the agent is told up front that pack-owned files are
 * gated, rather than discovering it only after a blocked tool call.
 *
 * Why sessionStart and not userPromptSubmitted: per the hooks reference
 * (https://docs.github.com/en/copilot/reference/hooks-reference, fetched
 * 2026-07-15), Copilot does fire a `userPromptSubmitted` event but does NOT
 * process its output — it cannot inject additionalContext or block
 * anything. `sessionStart` is the documented context-injection point
 * (output: `{ additionalContext }`, flat — not Claude Code's nested
 * `hookSpecificOutput` shape). The practical difference from the Claude
 * adapter is cadence: the instruction lands once per session instead of
 * once per turn, which is sufficient for a standing instruction.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const STANDING_INSTRUCTION =
  'scaffold-toolkit is configured in this repo (.scaffold/config.json exists). Any file a configured template ' +
  'pack declares ownership of (its targets[].output or injections[].file patterns) must be created or updated via ' +
  '"scaffold generate", never by a direct file write or edit — a preToolUse hook will block a raw write to such a file, ' +
  'and will block an edit unless it lands entirely inside an AI_IMPLEMENTATION marker interior (never inside a ' +
  'SCAFFOLD:<marker> injection region). Files outside any configured pack\'s declared patterns are unaffected.';

/** True whenever this repo is scaffold-managed — unconditional on anything else in the session. */
export function shouldInjectStandingInstruction(cwd) {
  return existsSync(path.join(cwd, '.scaffold', 'config.json'));
}

/** Pure decision function, unit-tested directly: the hook's stdout JSON for a given cwd's config presence. */
export function buildDecision(configPresent) {
  if (!configPresent) return {};
  return { additionalContext: STANDING_INSTRUCTION };
}

function main() {
  const raw = readFileSync(0, 'utf8');
  const hookInput = raw.trim() ? JSON.parse(raw) : {};
  const cwd = hookInput.cwd || process.cwd();

  process.stdout.write(JSON.stringify(buildDecision(shouldInjectStandingInstruction(cwd))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
