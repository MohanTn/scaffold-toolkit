/**
 * gh-scaffold subcommand dispatcher.
 *
 * Three public surfaces:
 *   - `dispatch(argv)` — pure-ish entry used by `bin/gh-scaffold` and by tests.
 *   - `printHelp` / `printVersion` — help and `-v` paths.
 *   - `doStatus` / `doGenerate` — the two real subcommands.
 *
 * Exit codes:
 *   0 — clean (subcommand succeeded, or precheck found nothing pending)
 *   1 — precheck blocked (status reported unresolved blocks) OR scaffold
 *       generate returned non-zero OR scaffold binary unreachable
 *   2 — usage error (unknown subcommand, missing --manifest)
 *
 * The split is deliberate: tool consumers (Copilot Chat agent, CI)
 * distinguish "you attempted something invalid" (2) from "the world state
 * is in your way" (1) without parsing stderr.
 */

import {
  buildPrecheckDecision,
  runGenerate,
  runStatus,
  renderPendingText,
} from './precheck.mjs';
import { readOwnPackageJson } from './version.mjs';
import { installHooks } from './installHooks.mjs';

const HELP = `gh-scaffold — gh CLI extension shim for @mohantn/scaffold-core

Usage:
  gh scaffold [--help]
      Print this help text.

  gh scaffold --version | -v | version
      Print the installed gh-scaffold version.

  gh scaffold install-hooks [--cwd <dir>]
      Write .github/hooks/scaffold-toolkit.json into the target repo,
      registering this package's postToolUse (soft nudge) and agentStop
      (hard block) hooks with Copilot CLI. Run this once per repo. This is
      what gives Copilot CLI the same "cannot stop with unfilled
      AI_IMPLEMENTATION blocks" guarantee Claude Code's Stop hook gives.

  gh scaffold status [--cwd <dir>] [--json]
      Run \`scaffold status --json\` in the target directory. Exits 0 when
      every previously-recorded AI_IMPLEMENTATION block is resolved,
      non-zero otherwise. With --json, prints the { resolvedAll, unresolved }
      object on stdout for tool parsing.

  gh scaffold generate --manifest <file> [--cwd <dir>] [--dry-run] [--force] [--json]
      Run \`scaffold status --json\` first. If any block is still unfilled,
      refuse (exit 1) and print the pending block list. This precheck is a
      second, independent layer on top of the agentStop hook above: the
      hook only fires inside a live Copilot agent session, while this
      precheck also covers \`gh scaffold generate\` invoked directly (CI, a
      script, a bare terminal) outside one. Otherwise, exec
      \`scaffold generate --manifest <file>\` and stream its TOON-formatted
      report on stdout. Pass-through flags --dry-run and --force are
      forwarded to scaffold-core; --json is not (see "What this shim does
      *not* do" in the README).

Background:
  gh-scaffold is a thin shim. It does not build the intent manifest — the
  Copilot Chat session is responsible for that (TOON or JSON against the
  published schema, just as Claude Code is). It does not fill
  AI_IMPLEMENTATION blocks — Copilot Chat does, using its own file-editing
  tool, finding each block via the report's \`content\` field.

Exit codes:
  0 success / precheck clean
  1 precheck blocked, scaffold error, or scaffold-core exited non-zero
  2 usage error (unknown subcommand or missing --manifest)
`;

function printHelp() {
  process.stdout.write(HELP);
  return 0;
}

function printVersion() {
  const pkg = readOwnPackageJson();
  process.stdout.write(`gh-scaffold ${pkg.version}\n`);
  return 0;
}

/**
 * Tiny argv parser, deliberately not pulling in commander. Supports
 * `--flag value`, `--flag=value`, `-f value`, bare flags (`-x` as truthy),
 * and `--` as a positional terminator.
 *
 * Heuristic for `--flag` (no `=`): consume the next arg as a value only
 * if it doesn't itself look like a flag. This keeps `--dry-run -v` from
 * silently pairing `--dry-run` with `-v` as its value. None of this
 * shim's flags accept negative numbers or `-`-prefixed values, so this
 * heuristic is precise across the supported surface; if a future flag
 * ever does accept a `-`-prefixed value, callers should switch to
 * `--flag=value` form for it.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string>, positional: string[] }}
 */
export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx !== -1) {
        flags[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next === '--' || /^-/.test(next)) {
          flags[key] = 'true';
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = 'true';
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/**
 * Build the argv forwarded to the real `scaffold generate` subprocess.
 * `--dry-run` and `--force` are pure scaffold-core flags with no shim-level
 * meaning, so they always forward. `--json` is deliberately excluded: the
 * shim consumes its own `--json` to choose its *own* precheck-blocked
 * envelope format (see `emitBlocked`), which is a different concern from
 * scaffold-core's report wire format (TOON vs JSON) on the success path —
 * forwarding it would conflate the two. See `end-to-end.test.mjs` for the
 * test that documents this on the success path.
 *
 * @param {Record<string, string>} flags
 * @param {string[]} positional
 * @returns {string[]}
 */
export function buildGeneratePassthrough(flags, positional) {
  const passthroughFlags = [];
  if (flags['dry-run'] === 'true') passthroughFlags.push('--dry-run');
  if (flags.force === 'true') passthroughFlags.push('--force');
  return [...passthroughFlags, ...positional];
}

/**
 * Render the "refusing to generate" output for a blocked precheck.
 * Routes to stdout JSON with --json, or to human-readable stderr otherwise.
 *
 * @param {{ unresolved: import('./precheck.mjs').UnresolvedBlock[] }} decision
 * @param {boolean} json
 */
function emitBlocked(decision, json) {
  if (json) {
    process.stdout.write(JSON.stringify({
      resolvedAll: false,
      unresolved: decision.unresolved,
      error: 'precheck_blocked',
    }) + '\n');
    return;
  }
  process.stderr.write(
    `gh-scaffold: refusing to generate — ${decision.unresolved.length} unresolved block(s) from a prior generate: ${renderPendingText(decision.unresolved)}\n` +
    `gh-scaffold: fill each one (use the report's content field to find the placeholder), or run \`scaffold undo <changeset-id>\`, then try again.\n` +
    `gh-scaffold: this is the closest host-portable equivalent to the Claude Code Stop-hook guarantee, given Copilot CLI has no equivalent hooks system.\n`,
  );
}

/**
 * @param {{ cwd: string }} args
 * @returns {Promise<number>}
 */
async function doInstallHooks({ cwd }) {
  try {
    const configPath = installHooks(cwd);
    process.stdout.write(`gh-scaffold: wrote ${configPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`gh-scaffold: install-hooks failed: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}

async function doStatus({ cwd, json }) {
  const { exitCode, stdout } = await runStatus(cwd);
  const decision = buildPrecheckDecision(exitCode, stdout);
  if (decision.ok) {
    if (json) {
      process.stdout.write(JSON.stringify({ resolvedAll: true, unresolved: [] }) + '\n');
    } else {
      process.stdout.write('gh-scaffold: precheck OK (no unresolved AI_IMPLEMENTATION blocks)\n');
    }
    return 0;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ resolvedAll: false, unresolved: decision.unresolved }) + '\n');
  } else {
    process.stderr.write(
      `gh-scaffold: precheck failed — ${decision.unresolved.length} unresolved block(s): ${renderPendingText(decision.unresolved)}\n` +
      `Run \`scaffold status --json\` for the underlying detail.\n`,
    );
  }
  return 1;
}

async function doGenerate({ manifestPath, cwd, json, passthrough }) {
  const { exitCode, stdout } = await runStatus(cwd);
  const decision = buildPrecheckDecision(exitCode, stdout);
  if (!decision.ok) {
    emitBlocked(decision, json);
    return 1;
  }

  // Precheck clean: hand off to scaffold-core, streaming its stdout/stderr
  // straight through so the consumer sees a report identical to what
  // `scaffold generate` would print on its own.
  const result = await runGenerate(cwd, manifestPath, passthrough);
  if (result.stdout) {
    process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

/**
 * Entry point used by `bin/gh-scaffold`. Returns the process exit code
 * rather than calling `process.exit` itself, so tests can drive it without
 * actually exiting the test runner.
 *
 * @param {string[]} argv  argv slice (subcommand + flags + positionals)
 * @returns {Promise<number>}
 */
export async function dispatch(argv) {
  const sub = argv[0];

  if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') {
    return printHelp();
  }
  if (sub === '-v' || sub === '--version' || sub === 'version') {
    return printVersion();
  }

  const { flags, positional } = parseFlags(argv.slice(1));

  if (sub === 'install-hooks') {
    return doInstallHooks({ cwd: flags.cwd || process.cwd() });
  }
  if (sub === 'status' || sub === 'precheck') {
    return doStatus({ cwd: flags.cwd || process.cwd(), json: !!flags.json });
  }
  if (sub === 'generate' || sub === 'run') {
    if (!flags.manifest) {
      process.stderr.write(
        'gh-scaffold: --manifest <file> is required for `generate`\n' +
        'Run `gh scaffold --help` for usage.\n',
      );
      return 2;
    }
    return doGenerate({
      manifestPath: flags.manifest,
      cwd: flags.cwd || process.cwd(),
      json: !!flags.json,
      passthrough: buildGeneratePassthrough(flags, positional),
    });
  }

  process.stderr.write(
    `gh-scaffold: unknown subcommand "${sub}"\n` +
    'Run `gh scaffold --help` for usage.\n',
  );
  return 2;
}
