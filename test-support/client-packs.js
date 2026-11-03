import { loadClientDescriptorPacks } from '../src/setup/agents/descriptor-packs.js';

// The built-in descriptor pack of a client, for tests.
export function builtInClientPack(id) {
  const pack = loadClientDescriptorPacks().find((candidate) => candidate.id === id);
  if (!pack) throw new TypeError(`No built-in client descriptor pack: ${id}`);
  return pack;
}
