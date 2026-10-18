import { objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };

// Same-task recovery after a blocked entry; never a task entry or snapshot.
export const TASK_PREFERENCE_DEFINITIONS = [
  {
    name: 'read_task_preferences',
    title: 'READ · Recover complete preferences for the owned task',
    description: 'Recover owned task preferences in the same verified native/sealed-worker session and stored scope. Follow next_cursor with the same token; apply only after every page of one revision, ending preferences_complete=true. A final page alone is incomplete. Invalid/expired cursor or changed snapshot: discard pages, restart reader without cursor. Never restart entry, invent sessions or widen authority; overflow stays blocked.',
    inputSchema: objectSchema({ taskContextToken: id, cursor: { ...stringSchema(), minLength: 1, maxLength: 128 } }, ['taskContextToken'])
  }
];
