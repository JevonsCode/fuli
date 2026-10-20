import { arraySchema, integerSchema, nullableStringSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 128 };
const dismissalText = { ...stringSchema(), minLength: 4, maxLength: 1000 };
const occupation = { ...stringSchema(), pattern: '^[a-z][a-z0-9_]{0,79}$' };

// Bole's dismissal duty and the two on-demand reads it leaves behind.
export const AGENT_DISMISSAL_DEFINITIONS = [
  {
    name: 'dismiss_project_agent',
    title: 'WRITE · Bole: dismiss an Agent with the user\'s reason',
    description: 'Bole (AR) duty: dismiss (开除) the Agent the user named, only when the user initiates or approves it; never choose whom yourself. First ask the user why and wait; never call this without their own reason or with a placeholder. lessons: up to 3 short reusable sentences from the reason for later Agents of the same occupation or project (default: the reason). Refused for project leads (hand off first), Agents with open tasks and system roles. Ends assignments; history, employee number and a memory handoff stay readable (get_agent_handoff).',
    inputSchema: objectSchema({
      personalSpaceId: id,
      agentId: id,
      reason: { ...dismissalText, description: 'The user\'s reason, in their words.' },
      lessons: arraySchema(dismissalText, { minItems: 1, maxItems: 3 })
    }, ['personalSpaceId', 'agentId', 'reason'])
  },
  {
    name: 'list_agent_dismissal_lessons',
    title: 'READ · Lessons from dismissed Agents',
    description: 'On demand: why Agents of the same occupation or project were dismissed and their lessons, newest first. Use when task entry or recruitment reports dismissal_lessons. Give occupations, a project or both; either matches.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      occupations: arraySchema(occupation, { minItems: 1, maxItems: 8 }),
      personalProjectId: { ...nullableStringSchema(), minLength: 1, maxLength: 128 },
      query: { ...nullableStringSchema(), minLength: 1, maxLength: 200 },
      limit: integerSchema({ minimum: 1, maximum: 10 })
    }, ['personalSpaceId'])
  },
  {
    name: 'get_agent_handoff',
    title: 'READ · Handoff of a dismissed Agent',
    description: 'Markdown handoff stored when an Agent was dismissed: identity, reason, lessons and working memory. Read it when taking over its work.',
    inputSchema: objectSchema({ personalSpaceId: id, agentId: id }, ['personalSpaceId', 'agentId'])
  }
];
