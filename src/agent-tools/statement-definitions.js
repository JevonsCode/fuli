import { boundedString, integerSchema, objectSchema } from './schema.js';
import { MAX_WEEKS } from '../statement/compounding-statement.js';

// The person's compounding statement for their own AI (src/statement). Full
// profile only; chat reaches it through list_agent_interfaces/fuli_call.
export const STATEMENT_DEFINITIONS = [
  {
    name: 'read_compounding_statement',
    title: 'READ · Compounding statement',
    description: 'The person\'s 复利账单: counts FULI has for a window (default this local week), each with a line saying '
      + 'whether FULI observed it or Agents reported it. unavailable names sections that could not be read; never estimate them.',
    inputSchema: objectSchema({
      from: { ...boundedString(40), description: 'ISO 8601 instant with zone' },
      to: { ...boundedString(40), description: 'ISO 8601 instant with zone' },
      weeks: integerSchema({ minimum: 1, maximum: MAX_WEEKS }),
      usage: { type: 'boolean', description: 'Also return usage: task entries and wakes (answered, failed) by client and model, '
        + 'model null when not reported' }
    })
  }
];
