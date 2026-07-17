'use strict';

/**
 * Pack-local Handlebars helpers for the react-app pack.
 *
 * The scaffold-core engine loads this `helpers.js` from each pack folder on
 * descriptor-load and calls `module.exports.register(Handlebars)` once. All
 * helpers operate on String inputs only and never touch the filesystem,
 * shell, or network — pure transforms.
 */

function pascalCase(s) {
  const str = String(s == null ? '' : s).replace(/[-_]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function camelCase(s) {
  const p = pascalCase(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function kebabCase(s) {
  return String(s == null ? '' : s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

module.exports = {
  register(handlebars) {
    handlebars.registerHelper('pascal', (s) => pascalCase(s));
    handlebars.registerHelper('camel', (s) => camelCase(s));
    handlebars.registerHelper('kebab', (s) => kebabCase(s));
    handlebars.registerHelper('eq', (a, b) => a === b);

    // packageName: kebab-cased options.projectName, defaults to "my-app" — used for package.json's "name" and index.html's <title>.
    handlebars.registerHelper('packageName', function (options) {
      const root = options.data && options.data.root ? options.data.root : {};
      const p = root.options && root.options.projectName;
      return p ? kebabCase(p) : 'my-app';
    });

    // displayName: pascal-cased options.projectName, defaults to "My App" (spaced) — used for on-page headings.
    handlebars.registerHelper('displayName', function (options) {
      const root = options.data && options.data.root ? options.data.root : {};
      const p = root.options && root.options.projectName;
      const pascal = p ? pascalCase(p) : 'MyApp';
      return pascal.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    });
  },
};
