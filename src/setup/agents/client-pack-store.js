import { z } from 'zod';
import { contentHash } from '../../../packages/roundtable/src/canonical-json.js';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { jsonFormat, requireJsonFormatVersion, writeVersionedJsonFileAtomic } from '../../storage/json-format.js';
import { loadClientDescriptorPacks } from './descriptor-packs.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const ledgerFile = z.object({ path: z.string(), backupPath: z.string(), beforeDigest: digest.nullable(), afterDigest: digest }).strict();
const stateSchema = z.object({
  version: z.literal(1), schemaFingerprint: digest,
  active: z.record(z.string(), z.string()), packages: z.record(z.string(), z.unknown()),
  history: z.record(z.string(), z.array(z.unknown())),
  ledger: z.array(z.object({ operation: z.string(), id: z.string(), from: z.string(), to: z.string(),
    status: z.enum(['pending', 'applied', 'failed', 'recovered']), rollback: z.boolean().optional(),
    files: z.array(ledgerFile).optional(), restoreFailures: z.array(z.string()).optional()
  }).strict())
}).strict();
const SCHEMA_FINGERPRINT = contentHash(z.toJSONSchema(stateSchema));
function validateState(state) {
  stateSchema.parse(state);
  if (state.schemaFingerprint !== SCHEMA_FINGERPRINT) throw new TypeError('Client pack store schema fingerprint mismatch');
  return state;
}
export const CLIENT_PACK_FORMAT = jsonFormat({ store: 'client-packs', versions: [1] });
export function readClientPackState(dataDir) {
  let value;
  try { value = JSON.parse(readFileSync(join(dataDir, 'client-packs.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, schemaFingerprint: SCHEMA_FINGERPRINT, active: {}, packages: {}, history: {}, ledger: [] }; throw error; }
  requireJsonFormatVersion(value, CLIENT_PACK_FORMAT);
  return validateState(value);
}
export function writeClientPackState(dataDir, state) {
  writeVersionedJsonFileAtomic(join(dataDir, 'client-packs.json'), validateState(state), CLIENT_PACK_FORMAT, { durable: true });
}
export function installedClientPacks(dataDir) {
  const state = readClientPackState(dataDir);
  const overrides = Object.values(state.active).map(key => {
    const pack = state.packages[key];
    if (!pack) throw new TypeError(`Missing installed client pack: ${key}`);
    return pack;
  });
  return loadClientDescriptorPacks({ trustedOverrides: overrides });
}
