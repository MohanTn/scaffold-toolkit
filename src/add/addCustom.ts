/**
 * `scaffold add custom` — a custom query/command operation layered onto an
 * EXISTING controller and repository: new Query/Command + Handler files plus
 * marker injections (`CONTROLLER_ACTIONS`, `REPO_INTERFACE_METHODS`,
 * `REPO_IMPL_METHODS`) into the files already on disk. Pure compiler; the
 * injections themselves are declared by the pack under the
 * `custom-endpoint` artifact tag.
 */

import type { IntentManifest } from '../manifest/types.js';
import { validateManifest } from '../manifest/decode.js';
import { parsePropertyList } from './common.js';

export interface AddCustomFlags {
  name: string;
  returnType: string;
  targetStack: string;
  parameters?: string;
  method?: string;
  route?: string;
  targetController?: string;
  entity?: string;
  isCommand?: boolean;
  combine?: boolean;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * `--entity` wins when given; otherwise the entity is derived from the
 * controller name by stripping the `Controller` suffix and a plural `s`
 * (`ProductsController` → `Product`). Naive singularization on purpose —
 * it's deterministic and matches the pack's own pluralization convention;
 * an irregular plural just means passing `--entity` explicitly.
 */
export function deriveEntity(targetController: string | undefined, entity: string | undefined): string {
  if (entity !== undefined) return entity;
  if (targetController === undefined) {
    throw new Error('need --target-controller or --entity to know which entity the operation belongs to');
  }
  const base = targetController.replace(/Controller$/, '');
  const singular = base.endsWith('s') ? base.slice(0, -1) : base;
  if (!/^[A-Z][A-Za-z0-9]*$/.test(singular)) {
    throw new Error(`cannot derive a PascalCase entity from --target-controller "${targetController}" — pass --entity explicitly`);
  }
  return singular;
}

export function compileAddCustom(flags: AddCustomFlags): IntentManifest {
  const methodName = flags.name;
  if (!/^[A-Z][A-Za-z0-9]*$/.test(methodName)) {
    throw new Error(`invalid --name "${methodName}" — expected a PascalCase operation name, e.g. GetProductsWithFilter`);
  }

  const httpMethod = (flags.method ?? 'GET').toUpperCase();
  if (!HTTP_METHODS.has(httpMethod)) {
    throw new Error(`invalid --method "${flags.method}" — expected one of GET, POST, PUT, DELETE, PATCH`);
  }

  const entity = deriveEntity(flags.targetController, flags.entity);
  const targetController = flags.targetController ?? `${entity}sController`;

  const options: Record<string, unknown> = {};
  if (flags.isCommand === true) options.isCommand = true;
  if (flags.combine === true) options.combine = true;

  const manifest: IntentManifest = {
    manifestSchemaVersion: 1,
    targetStack: flags.targetStack,
    entity,
    options,
    artifacts: ['custom-endpoint'],
    methodName,
    returnType: flags.returnType,
    httpMethod,
    targetController,
    parameters: flags.parameters !== undefined ? parsePropertyList(flags.parameters, '--parameters') : [],
  };
  if (flags.route !== undefined) manifest.route = flags.route;
  return validateManifest(manifest);
}
