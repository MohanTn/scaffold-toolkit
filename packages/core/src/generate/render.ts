/** Handlebars compile+render for create-mode targets and injection snippets. */

import { readFileSync } from 'node:fs';
import Handlebars from 'handlebars';

/**
 * `noEscape: true` — these templates render source code (C#, TS, ...), not
 * HTML, so Handlebars's default HTML-entity escaping (quotes -> `&quot;`
 * etc.) would corrupt generated code.
 */
function compile(source: string): HandlebarsTemplateDelegate {
  return Handlebars.compile(source, { noEscape: true });
}

export function renderTemplateFile(templatePath: string, context: unknown): string {
  const source = readFileSync(templatePath, 'utf8');
  return compile(source)(context);
}

export function renderPathTemplate(pathTemplate: string, context: unknown): string {
  return compile(pathTemplate)(context);
}
