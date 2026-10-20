import { enumSchema, integerSchema, nullableStringSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 128 };
const optionalId = { ...nullableStringSchema(), minLength: 1, maxLength: 128 };

// Bole's zero-token score card: a read inside its agents.read and tasks.read
// permissions. The card and its task drill-down share one schema to keep the
// full tool list small.
export const AGENT_SCORE_CARD_DEFINITIONS = [
  {
    name: 'get_agent_score_card',
    title: 'READ · Bole: an Agent\'s score card',
    description: 'Bole read, no model call: an Agent\'s recorded outcomes as separate dimensions with samples, no total. 数据不足 (below minimumSample) is no conclusion; unreported or idle work is not poor work. A tier is a label with its evidence count, never grounds for automatic action. toolFlags: poor on one executor only, so suggest another model or client, not another Agent. Add dimension (and executorId) for the task IDs behind it, newest first.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      agentId: id,
      personalProjectId: optionalId,
      dimension: enumSchema(['completion', 'firstPass', 'userFeedback', 'review']),
      executorId: optionalId,
      limit: integerSchema({ minimum: 1, maximum: 200 })
    }, ['personalSpaceId', 'agentId'])
  }
];
