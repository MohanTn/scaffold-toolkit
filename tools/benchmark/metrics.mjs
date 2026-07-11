/**
 * Pure extractor over `claude -p ... --output-format json`'s result object.
 * No live API calls happen here — this module only ever receives an
 * already-parsed JSON object, from either a real run-benchmark.mjs
 * invocation or a checked-in recorded sample (test/fixtures/sample-claude-result.json).
 *
 * Field names below (`total_cost_usd`, `usage.input_tokens`,
 * `usage.output_tokens`, `duration_ms`, `num_turns`) are the widely-
 * documented `--output-format json` result shape, NOT independently
 * re-verified against a live `claude -p "say hi" --output-format json`
 * call this session — deliberately not spent (see the plan's Verification
 * section, step 4, and run-benchmark.mjs's own header comment). Before
 * trusting this harness's real numbers, run that one real call and
 * confirm/correct the field names below against the actual payload.
 */

export function extractMetrics(resultJson) {
  const usage = resultJson && typeof resultJson.usage === 'object' ? resultJson.usage : {};
  return {
    costUsd: typeof resultJson?.total_cost_usd === 'number' ? resultJson.total_cost_usd : null,
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
    durationMs: typeof resultJson?.duration_ms === 'number' ? resultJson.duration_ms : null,
    numTurns: typeof resultJson?.num_turns === 'number' ? resultJson.num_turns : null,
  };
}

/** Null (not 0, not NaN) when either half is unavailable — a missing token count must never silently read as "zero tokens used." */
export function totalTokens(metrics) {
  if (metrics.inputTokens === null || metrics.outputTokens === null) return null;
  return metrics.inputTokens + metrics.outputTokens;
}

function formatUsd(value) {
  return value === null ? 'unknown' : `$${value.toFixed(4)}`;
}

function formatCount(value) {
  return value === null ? 'unknown' : String(value);
}

/**
 * Renders one arm's metrics + independently-measured wall-clock time +
 * dotnet build result as a Markdown section body. `wallClockMs` is measured
 * by the caller around the `spawnSync` call (arms/*.mjs), independent of
 * whatever `duration_ms` the CLI itself reports — a real cross-check, not a
 * duplicate of the same number.
 */
export function formatMetricsSummary(metrics, wallClockMs, buildResult) {
  const total = totalTokens(metrics);
  return [
    `- cost: ${formatUsd(metrics.costUsd)}`,
    `- tokens: ${formatCount(total)} (input ${formatCount(metrics.inputTokens)} / output ${formatCount(metrics.outputTokens)})`,
    `- reported duration: ${formatCount(metrics.durationMs)} ms`,
    `- measured wall-clock: ${wallClockMs} ms`,
    `- turns: ${formatCount(metrics.numTurns)}`,
    `- dotnet build: ${buildResult.ok ? 'PASS' : 'FAIL'}${buildResult.ok ? '' : `\n\n\`\`\`\n${buildResult.detail}\n\`\`\``}`,
  ].join('\n');
}
