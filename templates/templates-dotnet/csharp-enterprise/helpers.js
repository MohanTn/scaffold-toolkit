'use strict';

/**
 * Pack-local Handlebars helpers for the v9-enterprise pack.
 *
 * The scaffold-core engine loads this `helpers.js` from each pack folder on
 * descriptor-load and calls `module.exports.register(Handlebars)` once. See
 * the pack README's "Helpers" section for the full convention.
 *
 * All helpers operate on String inputs only and never touch the filesystem,
 * shell, or network — they are pure transforms, which matches the PRD's
 * explicit safety rule for pack-supplied helpers.
 */

function pascalCase(s) {
  const str = String(s == null ? '' : s).replace(/[-_]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function guidFromString(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const guid = [
    (hash >>> 24) & 0xff,
    (hash >>> 16) & 0xff,
    (hash >>> 8) & 0xff,
    hash & 0xff,
  ]
    .map((x) => ('0' + Math.abs(x).toString(16)).slice(-2))
    .join('');
  return '{' + [guid.slice(0, 8), guid.slice(8, 12), guid.slice(12, 16), guid.slice(16, 20), guid.slice(20, 32)].join('-').toUpperCase() + '}';
}

// keyType: entity primary-key primitive, driven by options.keyType (guid|int|long|string).
// Defaults to guid, matching this pack's original hardcoded behavior.
const KEY_TYPES = {
  guid: { csType: 'Guid', valueGenerated: 'Never', newExpr: 'Guid.NewGuid()', emptyExpr: 'Guid.Empty', routeIdSegment: '{id:guid}' },
  int: { csType: 'int', valueGenerated: 'OnAdd', newExpr: 'default', emptyExpr: '0', routeIdSegment: '{id:int}' },
  long: { csType: 'long', valueGenerated: 'OnAdd', newExpr: 'default', emptyExpr: '0L', routeIdSegment: '{id:long}' },
  string: { csType: 'string', valueGenerated: 'Never', newExpr: 'Guid.NewGuid().ToString()', emptyExpr: 'string.Empty', routeIdSegment: '{id}' },
};

function resolveKeyType(options) {
  const root = options.data && options.data.root ? options.data.root : {};
  const raw = root.options && root.options.keyType ? String(root.options.keyType).toLowerCase() : 'guid';
  return KEY_TYPES[raw] || KEY_TYPES.guid;
}

/** @type {{ register: (handlebars: { registerHelper: (name: string, fn: Function) => void }) => void }} */
module.exports = {
  register(handlebars) {
    handlebars.registerHelper('keyType', function (options) { return resolveKeyType(options).csType; });
    handlebars.registerHelper('keyValueGenerated', function (options) { return resolveKeyType(options).valueGenerated; });
    handlebars.registerHelper('keyNewExpr', function (options) { return resolveKeyType(options).newExpr; });
    handlebars.registerHelper('keyEmptyExpr', function (options) { return resolveKeyType(options).emptyExpr; });
    handlebars.registerHelper('keyRouteIdSegment', function (options) { return resolveKeyType(options).routeIdSegment; });

    handlebars.registerHelper('lower', (s) => String(s == null ? '' : s).toLowerCase());

    handlebars.registerHelper('eq', (a, b) => a === b);

    // isNullable: true when a manifest field type is C#-nullable (ends with '?').
    handlebars.registerHelper('isNullable', (t) => String(t == null ? '' : t).trim().endsWith('?'));

    handlebars.registerHelper('default', function (value, fallback) {
      return value == null || value === '' ? fallback : value;
    });

    handlebars.registerHelper('camel', function (s) {
      const str = String(s == null ? '' : s);
      return str.charAt(0).toLowerCase() + str.slice(1);
    });

    handlebars.registerHelper('pascal', function (s) {
      const str = String(s == null ? '' : s).replace(/[-_]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
      return str.charAt(0).toUpperCase() + str.slice(1);
    });

    handlebars.registerHelper('kebab', function (s) {
      return String(s == null ? '' : s)
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();
    });

    handlebars.registerHelper('plural', function (s) {
      const str = String(s == null ? '' : s);
      if (!str) return str;
      if (/(s|sh|ch|x|z)$/i.test(str)) return str + 'es';
      if (/[^aeiou]y$/i.test(str)) return str.slice(0, -1) + 'ies';
      if (/y$/i.test(str)) return str + 's';
      return str + 's';
    });

    // company: pascal-cased options.company, defaults to "Company".
    handlebars.registerHelper('company', function (options) {
      const root = options.data && options.data.root ? options.data.root : {};
      const c = root.options && root.options.company;
      return c ? pascalCase(c) : 'Company';
    });

    // projectName: pascal-cased options.projectName, defaults to "MyProject".
    handlebars.registerHelper('projectName', function (options) {
      const root = options.data && options.data.root ? options.data.root : {};
      const p = root.options && root.options.projectName;
      return p ? pascalCase(p) : 'MyProject';
    });

    // companyProjectName (alias solutionName): `{company}.{projectName}` for folder/csproj/sln naming.
    handlebars.registerHelper('companyProjectName', function (options) {
      const root = options.data && options.data.root ? options.data.root : {};
      // Brownfield override: a top-level companyProjectName (persisted in the
      // pack slot by scaffold bootstrap-markers, or set in the manifest) wins,
      // so existing single-token layouts like "ThetaDesk" are representable.
      if (root.companyProjectName) return String(root.companyProjectName);
      const c = root.options && root.options.company;
      const p = root.options && root.options.projectName;
      const company = c ? pascalCase(c) : 'Company';
      const project = p ? pascalCase(p) : 'MyProject';
      return company + '.' + project;
    });

    handlebars.registerHelper('solutionName', function (options) {
      return handlebars.helpers.companyProjectName(options);
    });

    // projectGuid: deterministic GUID from companyProjectName + arg, used in .sln file.
    // Simple hash-to-GUID, no external deps, pure function.
    handlebars.registerHelper('projectGuid', function (arg, options) {
      const root = options.data && options.data.root ? options.data.root : {};
      const c = root.options && root.options.company;
      const p = root.options && root.options.projectName;
      const company = c ? pascalCase(c) : 'Company';
      const project = p ? pascalCase(p) : 'MyProject';
      const seed = company + '.' + project + ':' + String(arg);
      return guidFromString(seed);
    });

    // ns: project root namespace. Defaults to options.rootNamespace if set, else companyProjectName.
    handlebars.registerHelper('ns', function (options) {
      const root = options.data && options.data.root ? options.data.root : {};
      if (root.options && root.options.rootNamespace) {
        return root.options.rootNamespace;
      }
      if (root.companyProjectName) return String(root.companyProjectName);
      const c = root.options && root.options.company;
      const p = root.options && root.options.projectName;
      const company = c ? pascalCase(c) : 'Company';
      const project = p ? pascalCase(p) : 'MyProject';
      return company + '.' + project;
    });

    // route: explicit options.route, or `/api/<kebab-plural-entity>`.
    // opEnabled: whether a CRUD operation's controller actions should render.
    // No options.ops at all (a plain hand-written manifest) means every
    // operation is on; with options.ops present (what `scaffold add feature
    // --operations` compiles), only the listed operations render.
    handlebars.registerHelper('opEnabled', function (op, options) {
      const root = options.data && options.data.root ? options.data.root : {};
      const ops = root.options && root.options.ops;
      if (!ops || typeof ops !== 'object') return true;
      return ops[String(op)] === true;
    });

    // httpAttr: HTTP verb → ASP.NET attribute stem (GET → Get, POST → Post).
    handlebars.registerHelper('httpAttr', function (verb) {
      const v = String(verb == null ? '' : verb).toLowerCase();
      return v.charAt(0).toUpperCase() + v.slice(1);
    });

    handlebars.registerHelper('route', function (options) {
      const root = options.data && options.data.root ? options.data.root : {};
      const explicit = root.options && root.options.route;
      if (explicit) return explicit;
      const entity = String(root.entity || '');
      const kebab = entity
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();
      let plural = kebab;
      if (kebab) {
        if (/(s|sh|ch|x|z)$/i.test(kebab)) plural = kebab + 'es';
        else if (/[^aeiou]y$/i.test(kebab)) plural = kebab.slice(0, -1) + 'ies';
        else plural = kebab + 's';
      }
      return '/api/' + plural;
    });
  },
};
