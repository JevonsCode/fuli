import { objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };

// Same-task recovery after a blocked entry; never a task entry or snapshot.
export const TASK_PREFERENCE_DEFINITIONS = [
  {
    name: 'read_task_preferences',
    title: 'READ · Recover complete preferences for the owned task',
    description: 'After blocked entry delivery, read complete current mandatory preferences for the original taskContextToken. Requires the same verified native/sealed-worker session and stored task scope. Never creates/rebinds tasks, selects Agents, loads private memory, or records views. Apply nothing unless preferences_complete=true; source/delivery overflow stays blocked. If unexposed, discover through list_agent_interfaces only with host permission. Never restart entry or invent a session for recovery.',
    inputSchema: objectSchema({ taskContextToken: id }, ['taskContextToken'])
  }
];
