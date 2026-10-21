import { loadClientDescriptorPacks } from '../src/setup/agents/descriptor-packs.js';

// The built-in descriptor pack a writer test configures a client with.
export function builtInClientPack(id) {
  const pack = loadClientDescriptorPacks().find((candidate) => candidate.id === id);
  if (!pack) throw new TypeError(`No built-in client descriptor pack: ${id}`);
  return pack;
}
