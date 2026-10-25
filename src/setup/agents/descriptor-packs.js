import { readFileSync } from 'node:fs';
import { ApplicationError } from '../../app/application-error.js';
import { compareSemanticVersions } from '../../semantic-version.js';
import { parseClientDescriptor } from './descriptor-schema.js';

const BUILT_IN_PACKS = Object.freeze(['codex', 'claude-code', 'cursor', 'opencode']);
function builtInPack(id) {
  const pack = parseClientDescriptor(JSON.parse(readFileSync(new URL(`./${id}/descriptor.json`, import.meta.url), 'utf8')));
  if (pack.id !== id) throw new TypeError(`Client descriptor pack ${id} names another client: ${pack.id}`);
  return pack;
}

// Only the pinned-manifest installation path supplies trustedOverrides. Ordinary
// external descriptors cannot claim an npm id. New npm packs always win ties.
export function loadClientDescriptorPacks({ reservedIds = [], external = [], trustedOverrides = [] } = {}) {
  const builtIn = BUILT_IN_PACKS.map(builtInPack);
  const claimed = new Set([...reservedIds, ...BUILT_IN_PACKS]);
  const overrides = new Map();
  for (const value of trustedOverrides) {
    const pack = parseClientDescriptor(value);
    const base = builtIn.find(candidate => candidate.id === pack.id);
    if (!base || reservedIds.includes(pack.id)) throw new ApplicationError('client_pack_reserved',
      `Client override id is reserved or unknown: ${pack.id}`, { status: 409 });
    if (overrides.has(pack.id)) throw new TypeError(`Duplicate client override: ${pack.id}`);
    if (['configWriter', 'command', 'schemaVersion'].some(field => pack[field] !== base[field])) {
      throw new TypeError(`Client override is incompatible with built-in: ${pack.id}`);
    }
    overrides.set(pack.id, compareSemanticVersions(pack.version, base.version) > 0 ? pack : base);
  }
  const additions = external.map(value => {
    const pack = parseClientDescriptor(value);
    if (claimed.has(pack.id)) throw new ApplicationError('client_pack_reserved',
      `A built-in client cannot be replaced by an external pack: ${pack.id}`, { status: 409 });
    claimed.add(pack.id); return pack;
  });
  return Object.freeze([...builtIn.map(pack => overrides.get(pack.id) ?? pack), ...additions]);
}
