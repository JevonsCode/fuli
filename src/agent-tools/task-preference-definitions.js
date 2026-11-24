import { objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };

// Same-task recovery after a blocked entry; never a task entry or snapshot.
export const TASK_PREFERENCE_DEFINITIONS = [
  {
    name: 'read_task_preferences',
    title: 'READ · Recover complete preferences for the owned task',
    description: 'Read owned task preferences in the same verified native/sealed-worker session and stored scope. With keys (from preferences_omitted.index): those preferences whole, in one result, no paging. Without keys: recover the whole set; follow next_cursor with the same token and apply only after every page of one revision, ending preferences_complete=true. A final page alone is incomplete. Invalid/expired cursor or changed snapshot: discard pages, restart reader without cursor. Never restart entry, invent sessions or widen authority; overflow stays blocked.',
    inputSchema: objectSchema({ taskContextToken: id, cursor: { ...stringSchema(), minLength: 1, maxLength: 128 },
      keys: { type: 'array', items: id, minItems: 1, maxItems: 20 } }, ['taskContextToken'])
  }
];
