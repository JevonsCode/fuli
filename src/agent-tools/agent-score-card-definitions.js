import { booleanSchema, enumSchema, integerSchema, nullableStringSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 128 };
const optionalId = { ...nullableStringSchema(), minLength: 1, maxLength: 128 };

// Bole's zero-token score card: a read inside its agents.read and tasks.read
// permissions. The card, its task drill-down and Bole's suggested next step
// share one schema to keep the full tool list small.
export const AGENT_SCORE_CARD_DEFINITIONS = [
  {
    name: 'get_agent_score_card',
    title: 'READ · Bole: an Agent\'s score card',
    description: 'Bole read: outcomes per dimension with samples, no total. 数据不足 (< minimumSample) is no conclusion, never poor work. A tier is a label, never grounds for automatic action. toolFlags: poor on one executor only, so suggest another model or client, not another Agent. dimension (+executorId): its task IDs, newest first. review: Bole\'s model, if set, suggests one next step for one project; a suggestion only.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      agentId: id,
      personalProjectId: optionalId,
      dimension: enumSchema(['completion', 'firstPass', 'userFeedback', 'review']),
      executorId: optionalId,
      limit: integerSchema({ minimum: 1, maximum: 200 }),
      review: booleanSchema()
    }, ['personalSpaceId', 'agentId'])
  }
];
