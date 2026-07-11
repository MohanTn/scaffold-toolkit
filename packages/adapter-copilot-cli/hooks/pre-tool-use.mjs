#!/usr/bin/env node
/**
 * *** VERIFY BEFORE SHIP — HIGH RISK ***
 *
 * preToolUse hook for GitHub Copilot CLI: the hard gate mirroring the
 * Claude Code adapter's pre-tool-use.mjs — fires before a file-write/edit
 * tool call runs and shells out to `scaffold check-edit` to decide whether
 * to allow it.
 *
 * CONFIRMED (https://docs.github.com/en/copilot/reference/hooks-reference,
 * fetched 2026-07-11 during this feature's implementation): the preToolUse
 * envelope itself — input `{ sessionId, timestamp, cwd, toolName, toolArgs }`
 * and output `{ permissionDecision: "allow" | "deny" | "ask",
 * permissionDecisionReason }` to block. This matches the same field-name
 * convention `hooks/post-tool-use.mjs` already uses for `toolName`/`toolArgs`
 * (that file's own `bash`/`command` handling is separately confirmed by this
 * package's existing tests).
 *
 * **NOT CONFIRMED — genuinely guessed, not verified against a live session**:
 * which `toolName` value(s) correspond to a file write vs. an in-place edit,
 * and the field names *inside* `toolArgs` that carry the file path and (for
 * an edit) the old/new text. `EDIT_TOOL_NAMES` below guesses `'write'` and
 * `'edit'`; `extractEditRequest` guesses `toolArgs.path` for the file path
 * and `toolArgs.oldString` for the edit's replaced text, following Copilot's
 * documented camelCase convention elsewhere in this package. None of this is
 * backed by an inspected real payload. Per the plan: before this adapter is
 * considered ship-ready, register a throwaway logging preToolUse hook in a
 * real Copilot CLI session, trigger one real file write and one real file
 * edit, inspect the captured payloads, and correct `EDIT_TOOL_NAMES` /
 * `extractEditRequest` (and this comment) to match reality. Do not treat
 * this file as done until that live check has run.
 *
 * A `scaffold check-edit` invocation failure (binary missing, crash,
 * unparseable stdout) is treated as a block, not an allow — mirrors the
 * existing, intentional fail-closed behavior in agent-stop.mjs; don't "fix"
 * it into a silent bypass regardless of how uncertain the input-shape guess
 * above turns out to be.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// *** GUESS, unverified — see header comment ***
const EDIT_TOOL_NAMES = new Set(['write', 'edit']);

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

/**
 * Copilot's `toolArgs` field is typed `unknown` and has been observed (for
 * the `bash` tool, in post-tool-use.mjs) both as a plain object and as a
 * JSON-encoded string — handle both here too rather than assuming one shape.
 */
function parseToolArgs(toolArgs) {
  if (typeof toolArgs === 'string') {
    try {
      return JSON.parse(toolArgs);
    } catch {
      return undefined;
    }
  }
  if (toolArgs && typeof toolArgs === 'object') return toolArgs;
  return undefined;
}

/** True only for a tool call whose toolName is a guessed file write/edit tool — see the *** VERIFY BEFORE SHIP *** header comment. */
export function shouldCheckEdit(hookInput) {
  if (!hookInput) return false;
  return EDIT_TOOL_NAMES.has(hookInput.toolName);
}

/**
 * Pulls {file, tool, oldString} out of a preToolUse hook's `toolArgs`.
 * Field names (`path`, `oldString`) are unverified guesses — see the
 * *** VERIFY BEFORE SHIP *** header comment above.
 */
export function extractEditRequest(hookInput) {
  const args = parseToolArgs(hookInput && hookInput.toolArgs);
  if (!args) return undefined;
  const filePath = args.path;
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined;

  if (hookInput.toolName === 'write') {
    return { file: filePath, tool: 'write' };
  }
  const oldString = typeof args.oldString === 'string' ? args.oldString : undefined;
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
      permissionDecision: 'deny',
      permissionDecisionReason:
        `scaffold check-edit did not return a parseable decision (exit ${checkEditExitCode}) — blocking, fail-closed. ` +
        `Raw output: ${checkEditStdout.trim().slice(0, 500) || '(empty)'}`,
    };
  }

  if (result.allow) return { permissionDecision: 'allow' };

  return {
    permissionDecision: 'deny',
    permissionDecisionReason: result.detail || 'scaffold check-edit refused this write/edit.',
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

  // Zero-added-cost fast path: never spawn `scaffold` in a repo that isn't scaffold-managed at all.
  if (!existsSync(path.join(cwd, '.scaffold', 'config.json'))) {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    return;
  }

  if (!shouldCheckEdit(hookInput)) {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    return;
  }

  const editRequest = extractEditRequest(hookInput);
  if (!editRequest) {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    return;
  }

  const { exitCode, stdout } = runCheckEdit(cwd, editRequest.file, editRequest.tool, editRequest.oldString);
  process.stdout.write(JSON.stringify(buildDecision(exitCode, stdout)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
