import { objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };

// Same-task recovery after a blocked entry; never a task entry or snapshot.
export const TASK_PREFERENCE_DEFINITIONS = [
  {
    name: 'read_task_preferences',
    title: 'READ · Recover complete preferences for the owned task',
    description: 'Read the current complete mandatory preferences for the original taskContextToken after blocked entry delivery. Requires the same verified native or sealed-worker session and the stored task scope. Does not create or rebind a task, select an Agent, load private memory or record views. Apply nothing unless preferences_complete is true; source or delivery overflow remains blocked. If this tool is not exposed, discover it through list_agent_interfaces only when the host permits it. Never restart task entry or invent a session for recovery.',
    inputSchema: objectSchema({ taskContextToken: id }, ['taskContextToken'])
  }
];
