#!/usr/bin/env node
/**
 * postToolUse hook for GitHub Copilot CLI (schema per
 * https://docs.github.com/en/copilot/reference/hooks-reference, fetched
 * 2026-07-15): fires after every tool call in a Copilot agent session and
 * carries two independent, self-filtering jobs — every other tool call is
 * a silent no-op (exit 0, empty JSON).
 *
 * 1. Generate nudge (mirrors the Claude Code adapter's post-tool-use.mjs):
 *    when the tool was `bash`/`powershell` and its command invokes
 *    `scaffold generate`, run `scaffold status --json` in the session's cwd
 *    and, if anything is still pending, feed that back via the flat
 *    `additionalContext` field Copilot's postToolUse output uses (NOT
 *    Claude Code's nested `hookSpecificOutput.additionalContext` — the two
 *    protocols share the idea but not the JSON shape). A nudge, not a
 *    block: postToolUse fires after the tool already ran, so there is
 *    nothing left to prevent. The hard, un-skippable enforcement is the
 *    agentStop hook (agent-stop.mjs).
 *
 * 2. Coding-standards guidance (mirrors the injection the Claude Code
 *    adapter performs in its PreToolUse hook): when the tool was one of the
 *    doc-confirmed edit tools and its old-string targeted an
 *    AI_IMPLEMENTATION block in a scaffold-managed repo, look up the owning
 *    pack's `codingStandards` for the edited file and inject them as
 *    `additionalContext`. It lives here, not in pre-tool-use.mjs, because
 *    Copilot's preToolUse output cannot carry additionalContext (its only
 *    documented fields are permissionDecision/permissionDecisionReason/
 *    modifiedArgs) — the guidance arrives one step later than on Claude
 *    Code, right after the fill, in time for the agent to review its own
 *    edit against the pack's rules. Fail-open: standards injection is
 *    optional; enforcement (check-edit, in pre-tool-use.mjs) is not.
 *
 * Exit code contract: exit 0 with stdout parsed as this hook's output JSON.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolvePack,
  loadManifest,
  getStandardsForFile,
  formatStandardsGuidance,
} from './packManifestReader.mjs';

const SHELL_TOOL_NAMES = new Set(['bash', 'powershell']);
const EDIT_TOOL_NAMES = new Set(['edit', 'str_replace_editor', 'apply_patch']);

// Matches a real `scaffold generate` invocation whether run as the bare
// `scaffold` binary or via `npx @mohantn/scaffold-core` (which puts the
// package name's "-core" suffix directly before "generate", e.g.
// "npx -y @mohantn/scaffold-core generate --manifest x.toon"). A literal
// `command.includes('scaffold generate')` check misses that npx form
// entirely, which is the exact invocation SKILL.md instructs the agent to run.
const SCAFFOLD_GENERATE_PATTERN = /\bscaffold(?:-core)?\s+generate\b/;

/**
 * Copilot's `toolArgs` field is typed `unknown` and has been observed both
 * as a plain object and as a JSON-encoded string — handle both rather than
 * assuming one shape.
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

/** True only for a shell tool call whose command string invokes `scaffold generate` (directly or via `npx @mohantn/scaffold-core`). */
export function shouldCheckStatus(hookInput) {
  if (!hookInput || !SHELL_TOOL_NAMES.has(hookInput.toolName)) return false;
  const args = parseToolArgs(hookInput.toolArgs);
  const command = args && args.command;
  return typeof command === 'string' && SCAFFOLD_GENERATE_PATTERN.test(command);
}

/**
 * Pulls the {file, oldString} pair the standards lookup needs out of an
 * edit tool's `toolArgs`, tolerating the same candidate field names
 * pre-tool-use.mjs's extractEditRequest accepts (the docs type toolArgs
 * `unknown` and show no per-tool payload).
 */
export function extractStandardsTarget(hookInput) {
  const args = parseToolArgs(hookInput && hookInput.toolArgs);
  if (!args) return undefined;
  const filePath = [args.path, args.file_path, args.filePath].find((v) => typeof v === 'string' && v.length > 0);
  if (!filePath) return undefined;
  const oldString = [args.oldString, args.old_string, args.old_str].find((v) => typeof v === 'string');
  return { file: filePath, oldString };
}

/**
 * True when: an edit tool, oldString contains an AI_IMPLEMENTATION marker
 * (both syntaxes: _START and :START), repo is scaffold-managed. These are
 * the cases where we want to inject coding-standards guidance.
 */
export function shouldInjectStandards(hookInput, cwd) {
  if (!hookInput || !EDIT_TOOL_NAMES.has(hookInput.toolName)) return false;

  const target = extractStandardsTarget(hookInput);
  if (!target || typeof target.oldString !== 'string') return false;

  if (!/AI_IMPLEMENTATION[_:]START/.test(target.oldString)) return false;

  return existsSync(path.join(cwd, '.scaffold', 'config.json'));
}

function summarizeUnresolved(statusStdout) {
  try {
    const parsed = JSON.parse(statusStdout);
    const unresolved = Array.isArray(parsed.unresolved) ? parsed.unresolved : [];
    if (unresolved.length === 0) return null;
    return unresolved.map((b) => `${b.file}:${b.startLine}-${b.endLine}`).join(', ');
  } catch {
    return statusStdout.trim() || null;
  }
}

/**
 * Pure decision function, kept separate from the child_process call so it
 * has real unit test coverage: given the exit code and stdout `scaffold
 * status --json` actually produced, returns the JSON object this hook
 * should print. A resolved status (exit 0) is a pure no-op — the empty
 * object provides no additionalContext, and the session proceeds as normal.
 */
export function buildDecision(statusExitCode, statusStdout) {
  if (statusExitCode === 0) return {};
  const summary = summarizeUnresolved(statusStdout);
  const detail = summary ? `: ${summary}` : ' (see scaffold status --json for detail).';
  return {
    additionalContext:
      `scaffold status reports unfilled AI_IMPLEMENTATION block(s) after this generate run${detail} ` +
      "Fill each one with your file-editing tool, using the block's current-content from the generate report so an already-completed block is never re-filled.",
  };
}

function runStatus(cwd) {
  try {
    const stdout = execFileSync('scaffold', ['status', '--json'], { cwd, encoding: 'utf8' });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? '' };
  }
}

function buildStandardsGuidance(cwd, file) {
  const packInfo = resolvePack(cwd, file);
  if (!packInfo) return null;
  const manifest = loadManifest(packInfo.packPath);
  if (!manifest) return null;
  const standards = getStandardsForFile(file, manifest);
  if (!standards) return null;
  return formatStandardsGuidance(standards, file);
}

function main() {
  const raw = readFileSync(0, 'utf8');
  const hookInput = raw.trim() ? JSON.parse(raw) : {};
  const cwd = hookInput.cwd || process.cwd();

  if (shouldCheckStatus(hookInput)) {
    const { exitCode, stdout } = runStatus(cwd);
    process.stdout.write(JSON.stringify(buildDecision(exitCode, stdout)));
    return;
  }

  if (shouldInjectStandards(hookInput, cwd)) {
    let guidance = null;
    try {
      guidance = buildStandardsGuidance(cwd, extractStandardsTarget(hookInput).file);
    } catch {
      // Fail open: standards injection is optional; enforcement (check-edit) is not.
    }
    process.stdout.write(JSON.stringify(guidance ? { additionalContext: guidance } : {}));
    return;
  }

  process.stdout.write('{}');
}

// Only run as a script (not when imported by tests for its pure functions).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
