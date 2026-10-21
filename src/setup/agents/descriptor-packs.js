import { readFileSync } from 'node:fs';
import { ApplicationError } from '../../app/application-error.js';
import { parseClientDescriptor } from './descriptor-schema.js';

// Built-in packs ship in the package next to their client's tests and are the
// fallback for every id they name; their trust is the npm package's.
const BUILT_IN_PACKS = Object.freeze(['codex', 'claude-code', 'cursor']);

function builtInPack(id) {
  const pack = parseClientDescriptor(JSON.parse(readFileSync(new URL(`./${id}/descriptor.json`, import.meta.url), 'utf8')));
  if (pack.id !== id) throw new TypeError(`Client descriptor pack ${id} names another client: ${pack.id}`);
  return pack;
}

// `reservedIds` are the clients still served by code adapters. `external`
// is the shape rec#18 part 2 (`fuli clients update`, pinned trusted source,
// diff before write) fills with packs it has verified; until then only tests
// pass it. An external pack can never claim a built-in or reserved id.
export function loadClientDescriptorPacks({ reservedIds = [], external = [] } = {}) {
  const claimed = new Set(reservedIds);
  const claim = (pack, origin) => {
    if (claimed.has(pack.id)) {
      throw origin === 'external'
        ? new ApplicationError('client_pack_reserved', `A built-in client cannot be replaced by an external pack: ${pack.id}`, { status: 409 })
        : new TypeError(`Client ${pack.id} is registered twice`);
    }
    claimed.add(pack.id);
    return pack;
  };
  const builtIn = BUILT_IN_PACKS.map((id) => claim(builtInPack(id), 'built-in'));
  return Object.freeze([...builtIn, ...external.map((value) => claim(parseClientDescriptor(value), 'external'))]);
}
