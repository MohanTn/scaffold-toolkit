/**
 * The one I/O seam of the `scaffold add` family: resolve the pack slot from
 * `.scaffold/config.json`, hand the compiled in-memory manifest to
 * `runGenerate`, and print the same report `scaffold generate` prints. Every
 * subcommand's action is compile → runAdd.
 */

import { loadConfig } from '../config/loader.js';
import { runGenerate } from '../generate/generate.js';
import type { IntentManifest } from '../manifest/types.js';
import { renderReport, renderReportAsDoc } from '../generate/report.js';
import { resolveSlot } from './common.js';
import type { AddRunFlags } from './common.js';

export async function runAdd(
  repoRoot: string,
  compile: (targetStack: string) => IntentManifest,
  flags: AddRunFlags,
): Promise<void> {
  const config = loadConfig(repoRoot);
  const targetStack = resolveSlot(config, flags.templateSet);
  const manifest = compile(targetStack);
  const report = await runGenerate({ repoRoot, manifest, dryRun: flags.dryRun, force: flags.force });
  console.log(flags.format === 'doc' ? renderReportAsDoc(report) : renderReport(report, flags.json ? 'json' : 'toon'));
}
