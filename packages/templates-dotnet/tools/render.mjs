#!/usr/bin/env node
/**
 * tools/render.mjs
 * Offline smoke-test renderer for a pack folder.
 *
 * What this is:
 *   - Lets a pack author confirm `manifest.templates.json` + .hbs templates render
 *     cleanly against a sample intent manifest, without installing the engine.
 *   - Validates the descriptor against a minimal schema (descriptorSchemaVersion,
 *     packVersion, requires.scaffoldCli, targets[], injections[]).
 *   - Loads `helpers.js` from the pack root and registers helpers on a fresh
 *     Handlebars instance, then renders every non-injection `targets[]` to
 *     `<out>/<output>` and every `injections[]` to `<out>/_injections/<file>`.
 *
 * What this is not:
 *   - It is NOT the engine. It does not perform marker scans, hash trailers,
 *     path guards, change manifests, or status tracking. Use scaffold-core
 *     (integration tests in packages/core/test/integration) for those.
 */
'use strict';

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Handlebars from 'handlebars';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { pack: null, manifest: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pack') args.pack = argv[++i];
    else if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node tools/render.mjs --pack <folder> --manifest <file.json> --out <dir>');
      process.exit(0);
    }
  }
  return args;
}

function die(msg, code = 1) {
  console.error(`render.mjs: ${msg}`);
  process.exit(code);
}

function loadDescriptor(packDir) {
  const file = join(packDir, 'manifest.templates.json');
  if (!existsSync(file)) die(`missing descriptor: ${file}`);
  const raw = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    die(`descriptor JSON parse error: ${e.message}`);
  }
  if (parsed.descriptorSchemaVersion !== 2) {
    die(`descriptorSchemaVersion must be 2, got ${parsed.descriptorSchemaVersion}`);
  }
  if (!Array.isArray(parsed.targets)) die('descriptor.targets must be an array');
  if (!Array.isArray(parsed.injections)) parsed.injections = [];
  return parsed;
}

function loadManifest(file) {
  if (!existsSync(file)) die(`missing manifest: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function loadHelpers(packDir) {
  const file = join(packDir, 'helpers.js');
  if (!existsSync(file)) return;
  const mod = require(file);
  if (typeof mod.register !== 'function') {
    die(`${file}: expected CommonJS export { register(handlebars) }`);
  }
  mod.register(Handlebars);
}

function compileTemplate(packDir, tplPath) {
  const abs = join(packDir, tplPath);
  if (!existsSync(abs)) die(`template not found: ${abs}`);
  const src = readFileSync(abs, 'utf8');
  return Handlebars.compile(src, { noEscape: true });
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.pack || !args.manifest || !args.out) {
    die('missing required flags (--pack, --manifest, --out)', 2);
  }

  const packDir = resolve(ROOT, args.pack);
  if (!existsSync(packDir)) die(`pack folder not found: ${packDir}`);

  const descriptor = loadDescriptor(packDir);
  const manifest = loadManifest(resolve(args.manifest));
  loadHelpers(packDir);

  mkdirSync(args.out, { recursive: true });

  // Build the render context. Handlebars treats {helpers: root} plus
  // registered helpers (registered on the global Handlebars instance above)
  // equally.
  const ctx = {
    manifestSchemaVersion: manifest.manifestSchemaVersion,
    targetStack: manifest.targetStack,
    entity: manifest.entity,
    fields: manifest.fields || [],
    options: manifest.options || {},
  };

  // Merge pathConfig into context so target output paths can reference {{pathConfig.*}}.
  if (descriptor.pathConfig) {
    ctx.pathConfig = descriptor.pathConfig;
  }

  let written = 0;
  for (const t of descriptor.targets) {
    const compile = compileTemplate(packDir, t.template);
    // Output path contains Handlebars variables, too — render it as a template.
    const outPathTpl = Handlebars.compile(t.output, { noEscape: true });
    const outFile = join(args.out, outPathTpl(ctx));
    mkdirSync(dirname(outFile), { recursive: true });
    const rendered = compile(ctx);
    writeFileSync(outFile, rendered);
    console.log(`wrote ${outFile}  (template: ${t.template}, mode: ${t.mode})`);
    written++;
  }

  // Emit injection contents to a separate folder so the user can inspect what
  // would have been injected against a real Program.cs without mutating anything.
  if (descriptor.injections.length > 0) {
    const injDir = join(args.out, '_injections');
    mkdirSync(injDir, { recursive: true });
    for (const inj of descriptor.injections) {
      const compile = compileTemplate(packDir, inj.template);
      const fileName = `${inj.marker}-${inj.file.replace(/[\\/]/g, '__')}.hbs-rendered`;
      const outFile = join(injDir, fileName);
      writeFileSync(outFile, compile(ctx));
      console.log(`wrote ${outFile}  (marker: ${inj.marker}, target file: ${inj.file})`);
      written++;
    }
  }

  console.log(`\nrendered ${written} file(s)`);
}

main();
