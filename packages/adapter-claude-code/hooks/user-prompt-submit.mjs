#!/usr/bin/env node
/**
 * UserPromptSubmit hook: fires before each turn starts. No `execFileSync`
 * at all — just an `existsSync` check on `.scaffold/config.json` — because
 * this hook is a complementary early-warning layer, not the enforcement
 * itself. The real, un-skippable gate is PreToolUse (pre-tool-use.mjs),
 * which actually blocks a disallowed Write/Edit; this hook only injects a
 * standing instruction into context every turn, unconditional on the
 * prompt's own content (per the user's decision recorded in the plan: no
 * content/keyword-based intent detection anywhere in this feature). Its
 * purpose is to make the PreToolUse block, if Claude hits it, unsurprising
 * — Claude is told up front that pack-owned files are gated, rather than
 * discovering it only after a blocked tool call.
 *
 * Contract (confirmed against https://code.claude.com/docs/en/hooks,
 * fetched 2026-07-11): UserPromptSubmit injects context via
 * `hookSpecificOutput.additionalContext` with `hookEventName:
 * "UserPromptSubmit"` — the same field shape PostToolUse uses for its own
 * nudge (post-tool-use.mjs), just under a different `hookEventName`.
 * UserPromptSubmit can also block the turn outright via a top-level
 * `decision: "block"` + `reason`, but this hook never does that — blocking
 * prompt submission itself would stop Claude from even reading the standing
 * instruction it's trying to deliver, which is self-defeating for a
 * complementary nudge layer whose only job is to inform, not enforce.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const STANDING_INSTRUCTION =
  'scaffold-toolkit is configured in this repo (.scaffold/config.json exists). Any file a configured template ' +
  'pack declares ownership of (its targets[].output or injections[].file patterns) must be created or updated via ' +
  '"scaffold generate", never by a direct Write or Edit — a PreToolUse hook will block a raw Write to such a file, ' +
  'and will block an Edit unless it lands entirely inside an AI_IMPLEMENTATION marker interior (never inside a ' +
  'SCAFFOLD:<marker> injection region). Files outside any configured pack\'s declared patterns are unaffected.';

/** True whenever this repo is scaffold-managed — unconditional on the prompt's own text, per the plan's no-content-detection decision. */
export function shouldInjectStandingInstruction(cwd) {
  return existsSync(path.join(cwd, '.scaffold', 'config.json'));
}

/** Pure decision function, unit-tested directly: the hook's stdout JSON for a given cwd's config presence. */
export function buildDecision(configPresent) {
  if (!configPresent) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: STANDING_INSTRUCTION,
    },
  };
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
