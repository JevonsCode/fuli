import { InvalidInputError } from '../app/application-error.js';

// Adding and removing a client the person describes by hand (custom-clients.js).
// agent-installer checks a new file: one it cannot read as a client is
// removed again, and its reason answers the request.
export function createCustomClients({ installer, store }) {
  return {
    async addCustomClient(input) {
      const before = await installer.status();
      if (before.status !== 'available') throw new TypeError('Client detection is unavailable');
      const { id } = store.add(input, before.clients.map((client) => client.id));
      const after = await installer.status();
      const problem = after.status === 'available'
        ? after.extensionErrors?.find(({ file }) => file === `${id}.json`) : null;
      if (after.status !== 'available' || problem || !after.clients.some((client) => client.id === id)) {
        store.remove(id);
        throw new InvalidInputError(problem?.message ?? 'The client could not be added');
      }
      return { id };
    },
    removeCustomClient(clientId) {
      store.remove(clientId);
      return { id: clientId };
    }
  };
}
