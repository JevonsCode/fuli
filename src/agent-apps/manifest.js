import { z } from 'zod';

import { packageFile, packageIdentifier, packageVersion } from '../employees/manifest.js';
import { invalidAppInput } from './errors.js';

const MAX_DATA_FORMAT = 1_000_000;
const MAX_ACCEPTED_FORMATS = 16;
const MAX_PERMISSIONS = 24;
// An app permission names one FULI Agent tool the app may call through its host.
const APP_PERMISSION = /^fuli\.[a-z][a-z0-9_]{0,63}$/;

const dataFormat = z.number().int().min(1).max(MAX_DATA_FORMAT);

// An app owns one data directory or none. `format` is the data format it writes;
// `accepts` lists the formats it can open, and opening another one converts the
// data to `format`, which `migration` declares reversible or not.
const appData = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('none') }).strict(),
  z.object({
    scope: z.literal('app'),
    format: dataFormat,
    accepts: z.array(dataFormat).min(1).max(MAX_ACCEPTED_FORMATS).optional(),
    migration: z.enum(['none', 'reversible', 'irreversible']).default('none')
  }).strict()
]);

// The employee package contract (`runtime.entry`, `runtime.webRoot`, permissions)
// extended for apps an Agent grows itself: either part is optional, a resident
// service is declared, and the data the app owns is described.
const agentAppManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: packageIdentifier,
  version: packageVersion,
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000),
  permissions: z.array(z.string().regex(APP_PERMISSION)).max(MAX_PERMISSIONS),
  runtime: z.object({
    apiVersion: z.literal(1),
    entry: packageFile.optional(),
    webRoot: packageFile.optional()
  }).strict().refine((runtime) => runtime.entry || runtime.webRoot, 'Declare a service entry, a webRoot, or both'),
  resident: z.boolean().default(false),
  data: appData
}).strict().superRefine((manifest, context) => {
  if (manifest.resident && !manifest.runtime.entry) {
    context.addIssue({ code: 'custom', path: ['resident'], message: 'A resident service needs runtime.entry' });
  }
  if (manifest.data.scope !== 'app') return;
  const accepts = manifest.data.accepts ?? [manifest.data.format];
  if (!accepts.includes(manifest.data.format)) {
    context.addIssue({ code: 'custom', path: ['data', 'accepts'], message: 'Must include the format this version writes' });
  }
  if (accepts.some((format) => format !== manifest.data.format) && manifest.data.migration === 'none') {
    context.addIssue({ code: 'custom', path: ['data', 'migration'],
      message: 'Opening another format converts the data; declare it reversible or irreversible' });
  }
});

// Returns the normalized manifest: the form that is stored, hashed and approved.
export function parseAgentAppManifest(value) {
  const parsed = agentAppManifestSchema.safeParse(value);
  if (!parsed.success) throw invalidAppInput('invalid_manifest', 'Invalid app manifest', parsed.error.issues);
  const manifest = parsed.data;
  const data = manifest.data.scope === 'app'
    ? { ...manifest.data, accepts: [...new Set(manifest.data.accepts ?? [manifest.data.format])].sort((a, b) => a - b) }
    : manifest.data;
  return { ...manifest, permissions: [...new Set(manifest.permissions)].sort(), data };
}

// The management view groups apps as a tool, a page or board, or a resident service.
export function agentAppType(manifest) {
  if (manifest.resident) return 'service';
  return manifest.runtime.webRoot ? 'page' : 'tool';
}
