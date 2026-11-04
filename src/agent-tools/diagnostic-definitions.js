import { DIAGNOSTIC_COMPONENTS, DIAGNOSTIC_LEVELS } from '../diagnostics/safe-event.js';
import { MAX_DIAGNOSTIC_LIMIT } from '../diagnostics/query.js';
import { boundedString, enumSchema, integerSchema, objectSchema } from './schema.js';

// FULI's own runtime failures (rec#73). Full profile only; chat reaches it
// through list_agent_interfaces/fuli_call, so no session pays for its schema.
export const DIAGNOSTIC_DEFINITIONS = [
  {
    name: 'read_diagnostic_events',
    title: 'READ · FULI runtime failures',
    description: 'When FULI misbehaves: failures its hooks, HTTP API, Graph Provider start and MCP tools caught, newest first, '
      + 'with counts. Empty is not healthy: check truncated, sourcesUnavailable and notCovered. Page with nextCursor.',
    inputSchema: objectSchema({
      from: { ...boundedString(40), description: 'ISO 8601 date-time' },
      to: { ...boundedString(40), description: 'ISO 8601 date-time' },
      component: enumSchema(DIAGNOSTIC_COMPONENTS),
      level: enumSchema(DIAGNOSTIC_LEVELS),
      code: boundedString(64),
      limit: integerSchema({ minimum: 1, maximum: MAX_DIAGNOSTIC_LIMIT }),
      cursor: boundedString(64)
    })
  }
];
