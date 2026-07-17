/**
 * The single-artifact `scaffold add` subcommands (`domain-event`, `factory`,
 * `helper`, `cloud-provider`, `scheduler-job`, `health-check`,
 * `outbox-processor`) share one declarative compiler: each row says which
 * artifact tag to scope the manifest to, which flags it takes, and how they
 * map onto manifest inputs/options. Adding a new artifact kind is one table
 * row plus templates in the pack.
 */

import type { IntentManifest } from '../manifest/types.js';
import { validateManifest } from '../manifest/decode.js';

export interface AddArtifactFlags {
  targetStack: string;
  name?: string;
  entity?: string;
  provider?: string;
  scheduler?: string;
  properties?: string;
}

interface ArtifactKind {
  /** Fixed artifact tag, or a function of the flags (helper picks guard/crypto by --name). */
  artifact: string | ((flags: AddArtifactFlags) => string);
  /** Flags this kind requires beyond --template-set. */
  requires?: Array<{ flag: keyof AddArtifactFlags; hint: string }>;
  /** Enum-constrained flag values, compiled into options. `optional` skips the flag silently when absent. */
  optionEnums?: Array<{ flag: keyof AddArtifactFlags; optionKey: string; allowed: string[]; optional?: boolean }>;
  /** PascalCase-validated --name compiled into this top-level manifest input. */
  nameInput?: string;
  /** Whether --entity is compiled into manifest.entity when present. */
  entityInput?: boolean;
  /**
   * Also render the pack's `base` artifact alongside this one. The dotnet
   * pack establishes `base` via `scaffold add feature` before any other
   * artifact runs, so its single-artifact kinds never need this. Packs with
   * no "feature" command (e.g. react-app) have no other bootstrap step, so
   * their kinds set this to render skip-if-exists base scaffolding (and any
   * barrel file a kind injects into) on first use — idempotent on repeats.
   */
  includeBase?: boolean;
}

export const ARTIFACT_KINDS: Record<string, ArtifactKind> = {
  'domain-event': {
    artifact: 'domain-event',
    requires: [{ flag: 'name', hint: '--name <EventName>, e.g. --name ProductCreated' }],
    nameInput: 'eventName',
    entityInput: true,
  },
  factory: {
    artifact: 'factory',
    requires: [{ flag: 'entity', hint: '--entity <Entity>, e.g. --entity Product' }],
    entityInput: true,
  },
  helper: {
    artifact: (flags) => {
      const helper = (flags.name ?? '').toLowerCase();
      if (helper !== 'guard' && helper !== 'crypto') {
        throw new Error('invalid --name for add helper — expected "guard" or "crypto"');
      }
      return `helper-${helper}`;
    },
    requires: [{ flag: 'name', hint: '--name guard | --name crypto' }],
  },
  'cloud-provider': {
    artifact: 'cloud-provider',
    requires: [{ flag: 'provider', hint: '--provider aws|azure|gcp' }],
    optionEnums: [{ flag: 'provider', optionKey: 'cloudProvider', allowed: ['aws', 'azure', 'gcp'] }],
  },
  'scheduler-job': {
    artifact: 'scheduler-job',
    requires: [{ flag: 'name', hint: '--name <JobName>, e.g. --name NightlyCleanup' }],
    nameInput: 'jobName',
    // The v9 job skeleton is BCL-only (BackgroundService + PeriodicTimer);
    // --scheduler records the intended adapter for a future config-only swap.
    optionEnums: [{ flag: 'scheduler', optionKey: 'scheduler', allowed: ['quartz', 'hangfire'], optional: true }],
  },
  'health-check': {
    artifact: 'health-check',
    requires: [{ flag: 'name', hint: '--name <CheckName>, e.g. --name Database' }],
    nameInput: 'checkName',
  },
  'outbox-processor': {
    artifact: 'outbox',
  },
  component: {
    artifact: 'component',
    requires: [{ flag: 'name', hint: '--name <ComponentName>, e.g. --name Button' }],
    nameInput: 'componentName',
    includeBase: true,
  },
  hook: {
    artifact: 'hook',
    // PascalCase in, camelCase (useToggle) derived by the pack's `camel` helper for the filename/export.
    requires: [{ flag: 'name', hint: '--name <HookName> (PascalCase, "use" prefix), e.g. --name UseToggle' }],
    nameInput: 'hookName',
    includeBase: true,
  },
  page: {
    artifact: 'page',
    requires: [{ flag: 'name', hint: '--name <PageName>, e.g. --name ProductsPage' }],
    nameInput: 'pageName',
    includeBase: true,
  },
  context: {
    artifact: 'context',
    requires: [{ flag: 'name', hint: '--name <ContextName>, e.g. --name Auth' }],
    nameInput: 'contextName',
    includeBase: true,
  },
  'api-client': {
    artifact: 'api-client',
    // PascalCase in (e.g. Products); the pack's `camel`/`kebab` helpers derive productsApi.js.
    requires: [{ flag: 'name', hint: '--name <ResourceName> (PascalCase), e.g. --name Products' }],
    nameInput: 'apiName',
    includeBase: true,
  },
};

export function compileAddArtifact(kindName: string, flags: AddArtifactFlags): IntentManifest {
  const kind = ARTIFACT_KINDS[kindName];
  if (!kind) {
    throw new Error(`unknown artifact kind "${kindName}" — expected one of ${Object.keys(ARTIFACT_KINDS).join(', ')}`);
  }

  for (const { flag, hint } of kind.requires ?? []) {
    if (flags[flag] === undefined || flags[flag] === '') {
      throw new Error(`scaffold add ${kindName} needs ${hint}`);
    }
  }

  const artifact = typeof kind.artifact === 'function' ? kind.artifact(flags) : kind.artifact;

  const manifest: IntentManifest = {
    manifestSchemaVersion: 1,
    targetStack: flags.targetStack,
    artifacts: kind.includeBase ? ['base', artifact] : [artifact],
  };

  if (kind.nameInput !== undefined) {
    const value = flags.name as string;
    if (!/^[A-Z][A-Za-z0-9]*$/.test(value)) {
      throw new Error(`invalid --name "${value}" — expected a PascalCase name`);
    }
    manifest[kind.nameInput] = value;
  }
  if (kind.entityInput && flags.entity !== undefined) manifest.entity = flags.entity;

  const options: Record<string, unknown> = {};
  for (const { flag, optionKey, allowed, optional } of kind.optionEnums ?? []) {
    if (optional && flags[flag] === undefined) continue;
    const raw = String(flags[flag]).toLowerCase();
    if (!allowed.includes(raw)) {
      throw new Error(`invalid --${String(flag)} "${flags[flag]}" — expected one of ${allowed.join('|')}`);
    }
    options[optionKey] = raw;
  }
  if (Object.keys(options).length > 0) manifest.options = options;

  return validateManifest(manifest);
}
