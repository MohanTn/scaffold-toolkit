#!/usr/bin/env node
/**
 * preToolUse hook for GitHub Copilot CLI: the hard gate mirroring the
 * Claude Code adapter's pre-tool-use.mjs — fires before a file-write/edit
 * tool call runs and shells out to `scaffold check-edit` to decide whether
 * to allow it.
 *
 * CONFIRMED (https://docs.github.com/en/copilot/reference/hooks-reference,
 * fetched 2026-07-15): the preToolUse envelope — input `{ sessionId,
 * timestamp, cwd, toolName, toolArgs }`, output `{ permissionDecision:
 * "allow" | "deny" | "ask", permissionDecisionReason }` (reason required
 * when denying) — and the file-tool names: `create` creates files;
 * `edit`, `str_replace_editor`, and `apply_patch` modify them. Unlike
 * Claude Code's PreToolUse, this event cannot inject additionalContext,
 * so the coding-standards guidance the Claude adapter emits here lives in
 * post-tool-use.mjs instead.
 *
 * NOT CONFIRMED: the field names *inside* `toolArgs` (the docs type it
 * `unknown` and show no per-tool payload). `extractEditRequest` therefore
 * accepts `path`/`file_path`/`filePath` for the file path and
 * `oldString`/`old_string`/`old_str` for an edit's replaced text. A shape
 * it can't read yields no edit request, which for a pack-owned file still
 * ends in a block via check-edit's own ambiguous-old-string fail-closed
 * path — never a silent bypass.
 *
 * Allow paths print `{}` (Copilot's default permission flow), not an
 * explicit `permissionDecision: "allow"`: this hook's mandate is to add a
 * gate on pack-owned files, and auto-approving every unrelated write would
 * silently widen permissions the user's own Copilot settings might prompt
 * on. (The deleted first draft of this adapter printed explicit allows;
 * that was wrong for exactly this reason.)
 *
 * A `scaffold check-edit` invocation failure (binary missing, crash,
 * unparseable stdout) is treated as a block, not an allow — this mirrors
 * the intentional fail-closed behavior in agent-stop.mjs; don't "fix" it
 * into a silent bypass. A hook that quietly permits the tool call the
 * moment its own gate breaks defeats the entire point of a hard gate.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Doc-confirmed toolName values (see header): one write-tool, three edit-tools.
const WRITE_TOOL_NAMES = new Set(['create']);
const EDIT_TOOL_NAMES = new Set(['edit', 'str_replace_editor', 'apply_patch']);

// Conservative threshold, well under Windows' CreateProcess ~32KB single
// command-line cap (the binding constraint across platforms — Linux's own
// ARG_MAX is much larger). An old_string longer than this rides along via a
// temp file and --old-string-file instead of a literal execFileSync argv
// element, so a large AI_IMPLEMENTATION interior body being edited can never
// make the spawn itself fail — which would make runCheckEdit's catch path
// deny a perfectly valid edit as if check-edit itself had rejected it, when
// really the process never started at all.
const OLD_STRING_ARG_THRESHOLD = 8000;

/** Pure predicate, unit-tested directly: whether old_string needs the --old-string-file fallback instead of a literal argv element. */
export function shouldUseOldStringFile(oldString) {
  return typeof oldString === 'string' && oldString.length > OLD_STRING_ARG_THRESHOLD;
}

/**
 * Copilot's `toolArgs` field is typed `unknown` and has been observed both
 * as a plain object and as a JSON-encoded string (the same ambiguity
 * post-tool-use.mjs handles for `bash`) — handle both rather than assuming
 * one shape.
 */
export function parseToolArgs(toolArgs) {
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

/** True only for the tool calls that can put unreviewed content on disk: the doc-confirmed create/edit tool names. */
export function shouldCheckEdit(hookInput) {
  if (!hookInput) return false;
  return WRITE_TOOL_NAMES.has(hookInput.toolName) || EDIT_TOOL_NAMES.has(hookInput.toolName);
}

/**
 * Pulls the {file, tool, oldString} triple `scaffold check-edit` needs out
 * of a preToolUse hook's `toolArgs`, tolerating the candidate field names
 * the header comment lists (the docs don't pin them down). A missing or
 * malformed file path returns undefined (nothing to check — main() then
 * falls through to the silent no-op, same as a non-edit tool). A missing
 * oldString on an edit call is passed through as undefined rather than
 * skipping the check — check-edit's own ambiguous-old-string path blocks
 * that case, fail-closed, instead of this hook silently skipping
 * enforcement over a shape it didn't expect.
 */
export function extractEditRequest(hookInput) {
  const args = parseToolArgs(hookInput && hookInput.toolArgs);
  if (!args) return undefined;
  const filePath = [args.path, args.file_path, args.filePath].find((v) => typeof v === 'string' && v.length > 0);
  if (!filePath) return undefined;

  if (WRITE_TOOL_NAMES.has(hookInput.toolName)) {
    return { file: filePath, tool: 'write' };
  }
  const oldString = [args.oldString, args.old_string, args.old_str].find((v) => typeof v === 'string');
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

  if (result.allow) return {};

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
