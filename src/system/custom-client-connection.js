import { listedMcpFiles } from '../agent-kits/client-detection.js';
import { InvalidInputError } from '../app/application-error.js';

// Adding and removing a client the person describes by hand (custom-clients.js).
// agent-installer checks a new file: one it cannot read as a client is
// removed again, and its reason answers the request. Removing one takes
// FULI's entry out of the client's file first; a client whose entry
// agent-installer could not take out stays, and its reason answers.
export function createCustomClients({ installer, store }) {
  return {
    async addCustomClient(input) {
      const before = await installer.status();
      if (before.status !== 'available') throw new TypeError('Client detection is unavailable');
      const { id } = store.add(input, before.clients.map((client) => client.id), listedMcpFiles(before.clients));
      const after = await installer.status();
      const problem = after.status === 'available'
        ? after.extensionErrors?.find(({ file }) => file === `${id}.json`) : null;
      if (after.status !== 'available' || problem || !after.clients.some((client) => client.id === id)) {
        store.remove(id);
        throw new InvalidInputError(problem?.message ?? 'The client could not be added');
      }
      return { id };
    },
    async removeCustomClient(clientId) {
      if (typeof clientId !== 'string' || !store.removable().has(clientId)) {
        throw new InvalidInputError('clientId must name a client added here');
      }
      const removed = await installer.remove([clientId]);
      if (removed.status !== 'available') throw new TypeError('Client detection is unavailable');
      const problem = removed.problems.find(({ client }) => client === clientId);
      if (problem || removed.partial) {
        throw new InvalidInputError(problem?.message ?? 'FULI\'s entry could not be taken out of the client\'s file');
      }
      store.remove(clientId);
      return { id: clientId };
    }
  };
}
