#!/usr/bin/env node
/**
 * tools/benchmark/run-benchmark.mjs
 *
 * *** SPENDS REAL MONEY *** — spawns two live `claude -p` sessions against
 * the Anthropic API. NEVER invoke this from an automated test or a CI job;
 * see README.md's cost warning. Building and unit-testing this harness
 * (fixtureRepo.mjs, metrics.mjs, prompts.mjs, and their tests) is this
 * feature's deliverable — actually running this script once, for real,
 * against the seeded Order entity is a separate, explicit user action (the
 * plan's Verification section, step 4), not part of this implementation
 * pass.
 *
 * Runs both arms against byte-identical copies of one shared base repo
 * (fixtureRepo.mjs), extracts metrics from each arm's `--output-format
 * json` result (metrics.mjs — field names are a documented-shape guess,
 * NOT independently verified against a live call this session), runs a
 * real `dotnet build` against each arm's resulting repo, and writes a
 * summary under tools/benchmark/results/<timestamp>/summary.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBaseRepo, copyBaseRepo, dotnetBuild, removeRepo } from './fixtureRepo.mjs';
import { runFreehandArm } from './arms/freehand.mjs';
import { runScaffoldedArm } from './arms/scaffolded.mjs';
import { extractMetrics, formatMetricsSummary } from './metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Per-arm spend cap, not a total — each arm gets its own `--max-budget-usd`.
// Override via env var rather than a CLI flag so a plain `npm run benchmark`
// (root package.json's script) still works without extra argv plumbing.
const MAX_BUDGET_USD = Number(process.env.SCAFFOLD_BENCHMARK_MAX_BUDGET_USD ?? '2');

function runArm(label, runFn, repoDir) {
  console.log(`\n--- running ${label} arm against ${repoDir} (spends real API money, cap $${MAX_BUDGET_USD}) ---`);
  const { stdout, stderr, status, wallClockMs } = runFn({ repoDir, maxBudgetUsd: MAX_BUDGET_USD });
  if (status !== 0) {
    console.error(`${label} arm: claude exited ${status}\n${stderr}`);
  }
  let resultJson;
  try {
    resultJson = JSON.parse(stdout);
  } catch {
    console.error(`${label} arm: --output-format json did not produce parseable JSON on stdout; metrics will read as "unknown"`);
    resultJson = {};
  }
  const metrics = extractMetrics(resultJson);
  const build = dotnetBuild(repoDir);
  return { label, metrics, wallClockMs, build };
}

async function main() {
  console.error(
    '\n*** run-benchmark.mjs spends real Anthropic API money (two live `claude -p` sessions). ***\n' +
    `Per-arm spend cap: $${MAX_BUDGET_USD} (override via SCAFFOLD_BENCHMARK_MAX_BUDGET_USD). Ctrl-C now to abort.\n`,
  );

  const baseDir = buildBaseRepo();
  let freehandDir;
  let scaffoldedDir;
  try {
    freehandDir = copyBaseRepo(baseDir);
    scaffoldedDir = copyBaseRepo(baseDir);
  } finally {
    // The base is only ever a template the two arms copy from — nothing
    // further needs it once both copies exist, regardless of what happens
    // to either arm afterward.
    removeRepo(baseDir);
  }

  // Each arm's temp checkout is cleaned up in its own try/finally, not a
  // single finally shared across both — an exception from the freehand arm
  // (e.g. dotnetBuild failing to spawn, or any other unexpected throw) must
  // not skip the scaffolded arm's cleanup, and vice versa. Before this,
  // a shared finally around both runArm calls meant one arm throwing left
  // the *other* arm's already-checked-out directory (and, previously, the
  // scaffolded arm's own scaffold-bin tmpdir) leaked on disk.
  let freehand;
  try {
    freehand = runArm('freehand', runFreehandArm, freehandDir);
  } finally {
    removeRepo(freehandDir);
  }

  let scaffolded;
  try {
    scaffolded = runArm('scaffolded', runScaffoldedArm, scaffoldedDir);
  } finally {
    removeRepo(scaffoldedDir);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = join(__dirname, 'results', timestamp);
  mkdirSync(resultsDir, { recursive: true });

  const summary = [
    `# scaffold-toolkit benchmark — ${timestamp}`,
    '',
    '## freehand',
    formatMetricsSummary(freehand.metrics, freehand.wallClockMs, freehand.build),
    '',
    '## scaffolded',
    formatMetricsSummary(scaffolded.metrics, scaffolded.wallClockMs, scaffolded.build),
    '',
  ].join('\n');

  const summaryPath = join(resultsDir, 'summary.md');
  writeFileSync(summaryPath, summary);
  console.log(`\nWrote ${summaryPath}`);
}

main().catch((error) => {
  console.error('run-benchmark.mjs failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
