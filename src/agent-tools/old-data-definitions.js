import { boundedString, objectSchema } from './schema.js';

// The person's own AI reads their old data (rec#80 group B), read-only. Full
// profile only; chat reaches it through list_agent_interfaces/fuli_call.
// Restoring is run_delegated_action; deleting now is the person's.
export const OLD_DATA_DEFINITIONS = [
  {
    name: 'read_old_data',
    title: 'READ · Old data FULI kept',
    description: 'No id: every backup FULI kept before a change (what left it, when, bytes, restorable) and the live/old data sizes. id: its files. id+path: one text file, first 32 KB; binaries refused. Restore: run_delegated_action POST /api/old-data/:id/restore; deleting is the person\'s.',
    inputSchema: objectSchema({
      id: boundedString(600),
      path: boundedString(600)
    })
  }
];
