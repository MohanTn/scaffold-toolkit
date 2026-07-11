#!/usr/bin/env node
/**
 * PreToolUse hook: the actual hard gate. Fires before Claude's Write/Edit
 * tool call runs, so — unlike PostToolUse/Stop, which only ever nudge or
 * block *after* the damage is already on disk — this is the only hook that
 * can stop a hand-written, un-scaffolded file from ever being written in
 * the first place. Shells out to `scaffold check-edit`, the host-agnostic
 * structural gate in packages/core, and translates its allow/block verdict
 * into Claude Code's PreToolUse decision protocol.
 *
 * Only acts on `Write` and `Edit` tool calls; every other tool is a silent
 * no-op. Checks `.scaffold/config.json` existence itself, via plain
 * `existsSync`, before spawning anything — the zero-added-cost requirement
 * for a repo that isn't scaffold-managed at all (this mirrors `scaffold
 * check-edit`'s own fast path, so an unconfigured repo pays for the check
 * exactly once, not twice).
 *
 * Contract (confirmed against https://code.claude.com/docs/en/hooks,
 * fetched 2026-07-11 during this feature's implementation — this is the
 * one item the plan flagged as needing independent re-confirmation before
 * ship, and it now is):
 *   - PreToolUse blocks via `hookSpecificOutput.permissionDecision: "deny"`
 *     plus `hookSpecificOutput.permissionDecisionReason`, NOT the top-level
 *     `decision: "block"` shape Stop/UserPromptSubmit use — those are a
 *     different field family for a different set of events. Allowing is
 *     either `permissionDecision: "allow"` or simply omitting
 *     `hookSpecificOutput` entirely (the default permission flow then
 *     applies) — this script uses the latter (an empty `{}`), matching
 *     post-tool-use.mjs's existing no-op convention, so it never overrides
 *     the user's own `acceptEdits`/`ask` permission mode on the allow path,
 *     only ever intervenes to deny.
 *   - The `matcher` field in settings.json hook configs supports pipe
 *     alternation (`"Write|Edit"` in one entry, confirmed via the same
 *     fetch) — SKILL.md's one-time-setup wiring uses that single-entry form.
 *
 * A `scaffold check-edit` invocation failure (binary missing, crash,
 * unparseable stdout) is treated as a block, not an allow — this mirrors
 * the existing, intentional fail-closed behavior already in
 * stop.mjs/agent-stop.mjs; don't "fix" it into a silent bypass. A hook that
 * quietly permits the tool call the moment its own gate breaks defeats the
 * entire point of a hard gate.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDIT_TOOLS = new Set(['Write', 'Edit']);

// Conservative threshold, well under Windows' CreateProcess ~32KB single
// command-line cap (the binding constraint across platforms — Linux's own
// ARG_MAX is much larger). An old_string longer than this rides along via a
// temp file and --old-string-file instead of a literal execFileSync argv
// element, so a large AI_IMPLEMENTATION interior body being edited can never
// make the spawn itself fail — which, before this threshold existed, made
// runCheckEdit's catch path deny a perfectly valid edit as if check-edit
// itself had rejected it, when really the process never started at all.
const OLD_STRING_ARG_THRESHOLD = 8000;

/** Pure predicate, unit-tested directly: whether old_string needs the --old-string-file fallback instead of a literal argv element. */
export function shouldUseOldStringFile(oldString) {
  return typeof oldString === 'string' && oldString.length > OLD_STRING_ARG_THRESHOLD;
}

/** True only for the two tool calls that can put unreviewed content on disk: Write and Edit. */
export function shouldCheckEdit(hookInput) {
  if (!hookInput) return false;
  return EDIT_TOOLS.has(hookInput.tool_name);
}

/**
 * Pulls the {file, tool, oldString} triple `scaffold check-edit` needs out
 * of a PreToolUse hook's `tool_input`, per Claude Code's documented
 * Write/Edit tool schemas (`file_path` on both; `old_string` on Edit only).
 * A missing/malformed `file_path` returns undefined (nothing to check —
 * main() then falls through to the silent no-op, same as a non-edit tool).
 * A missing `old_string` on an Edit call is passed through as undefined
 * rather than skipping the check — check-edit's own ambiguous-old-string
 * path blocks that case, fail-closed, instead of this hook silently
 * skipping enforcement over a shape it didn't expect.
 */
export function extractEditRequest(hookInput) {
  const toolInput = (hookInput && hookInput.tool_input) || {};
  const filePath = toolInput.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined;

  if (hookInput.tool_name === 'Write') {
    return { file: filePath, tool: 'write' };
  }
  const oldString = typeof toolInput.old_string === 'string' ? toolInput.old_string : undefined;
  return { file: filePath, tool: 'edit', oldString };
}

/**
 * Pure decision function, unit-tested directly: given `scaffold check-edit`'s
 * real exit code and stdout, returns the JSON this hook should print.
 */
export function buildDecision(checkEditExitCode, checkEditStdout) {
  let result;
  try {
    result = JSON.parse(checkEditStdout);
  } catch {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `scaffold check-edit did not return a parseable decision (exit ${checkEditExitCode}) — blocking, fail-closed. ` +
          `Raw output: ${checkEditStdout.trim().slice(0, 500) || '(empty)'}`,
      },
    };
  }

  if (result.allow) return {};

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.detail || 'scaffold check-edit refused this write/edit.',
    },
  };
}

function runCheckEdit(cwd, file, tool, oldString) {
  const args = ['check-edit', '--file', file, '--tool', tool];
  let tempDir;
  if (oldString !== undefined) {
    if (shouldUseOldStringFile(oldString)) {
      tempDir = mkdtempSync(path.join(tmpdir(), 'scaffold-check-edit-'));
      const tempFile = path.join(tempDir, 'old-string.txt');
      writeFileSync(tempFile, oldString, 'utf8');
      args.push('--old-string-file', tempFile);
    } else {
      args.push('--old-string', oldString);
    }
  }
  try {
    const stdout = execFileSync('scaffold', args, { cwd, encoding: 'utf8' });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? '' };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  const raw = readFileSync(0, 'utf8');
  const hookInput = raw.trim() ? JSON.parse(raw) : {};
  const cwd = hookInput.cwd || process.cwd();

  // Zero-added-cost fast path: a repo with no .scaffold/config.json never
  // spawns `scaffold` at all, matching check-edit's own fast path one layer
  // up so an unconfigured repo never even pays for a process spawn.
  if (!existsSync(path.join(cwd, '.scaffold', 'config.json'))) {
    process.stdout.write('{}');
    return;
  }

  if (!shouldCheckEdit(hookInput)) {
    process.stdout.write('{}');
    return;
  }

  const editRequest = extractEditRequest(hookInput);
  if (!editRequest) {
    process.stdout.write('{}');
    return;
  }

  const { exitCode, stdout } = runCheckEdit(cwd, editRequest.file, editRequest.tool, editRequest.oldString);
  process.stdout.write(JSON.stringify(buildDecision(exitCode, stdout)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
