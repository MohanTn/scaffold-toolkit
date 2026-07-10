/** Handlebars compile+render for create-mode targets and injection snippets. */

import { readFileSync } from 'node:fs';
import Handlebars from 'handlebars';

function toCamelCase(str: string): string {
  const words = str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split(/[_\-\s]+/);
  return words
    .map((word, idx) => {
      if (idx === 0) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

function toPascalCase(str: string): string {
  const words = str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split(/[_\-\s]+/);
  return words
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s\-]+/g, '_')
    .toLowerCase();
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function registerHelpers(): void {
  Handlebars.registerHelper('camel', (value: string) => toCamelCase(String(value)));
  Handlebars.registerHelper('camelCase', (value: string) => toCamelCase(String(value)));
  Handlebars.registerHelper('pascal', (value: string) => toPascalCase(String(value)));
  Handlebars.registerHelper('PascalCase', (value: string) => toPascalCase(String(value)));
  Handlebars.registerHelper('snake', (value: string) => toSnakeCase(String(value)));
  Handlebars.registerHelper('snake_case', (value: string) => toSnakeCase(String(value)));
  Handlebars.registerHelper('kebab', (value: string) => toKebabCase(String(value)));
  Handlebars.registerHelper('kebab-case', (value: string) => toKebabCase(String(value)));
  Handlebars.registerHelper('upper', (value: string) => String(value).toUpperCase());
  Handlebars.registerHelper('lower', (value: string) => String(value).toLowerCase());
  Handlebars.registerHelper('Camel', (value: string) => toCamelCase(String(value)));
}

let handlersRegistered = false;

/**
 * `noEscape: true` — these templates render source code (C#, TS, ...), not
 * HTML, so Handlebars's default HTML-entity escaping (quotes -> `&quot;`
 * etc.) would corrupt generated code.
 */
function compile(source: string): HandlebarsTemplateDelegate {
  if (!handlersRegistered) {
    registerHelpers();
    handlersRegistered = true;
  }
  return Handlebars.compile(source, { noEscape: true });
}

export function renderTemplateFile(templatePath: string, context: unknown): string {
  const source = readFileSync(templatePath, 'utf8');
  return compile(source)(context);
}

export function renderPathTemplate(pathTemplate: string, context: unknown): string {
  return compile(pathTemplate)(context);
}
