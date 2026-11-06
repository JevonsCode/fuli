import { nullableStringSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 128 };
const optionalId = { ...nullableStringSchema(), minLength: 1, maxLength: 128 };

// An FLA's occupation starter kit (docs/occupation-plugins.md), read on demand.
// Full profile only; chat reaches it through list_agent_interfaces/fuli_call.
export const OCCUPATION_KIT_DEFINITIONS = [
  {
    name: 'read_occupation_kit',
    title: 'READ · Occupation starter kit',
    description: 'Your occupation kit, read when starting such work, not every turn: upstream-quoted checklist and acceptance (with license), recommended Skills and MCP (enabled null = not answered; install only enabled Skills; never connect MCP). personalProjectId adds lessons the person kept.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      agentId: optionalId,
      occupation: optionalId,
      personalProjectId: optionalId
    }, ['personalSpaceId'])
  }
];
