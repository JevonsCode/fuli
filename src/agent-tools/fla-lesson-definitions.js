import { arraySchema, boundedString, enumSchema, objectSchema } from './schema.js';
import { CHECK_KINDS } from '../graphiti/task-experiences.js';

// An FLA records one lesson as it learns it (rec#78): a person's correction it
// judged lasting, or a lesson that can become an acceptance check. Full
// profile only, chat reaches it through list_agent_interfaces/fuli_call; the
// owner is the task's bound FLA, so it takes no agentId.
export const FLA_LESSON_DEFINITIONS = [
  {
    name: 'record_fla_lesson',
    title: 'WRITE · Record a lesson you learned',
    description: 'origin correction: when the person corrects you, correctionScope this_task (a one-off requirement: apply it, nothing is kept) or lasting (kept pending, boundary required). check: a lesson that can be checked, kept as an acceptance item or regression example once the person keeps it. The person keeps or drops it on your page.',
    inputSchema: objectSchema({
      taskContextToken: boundedString(256),
      origin: enumSchema(['correction', 'experience']),
      correctionScope: enumSchema(['this_task', 'lasting']),
      title: boundedString(240),
      solution: boundedString(2000),
      boundary: boundedString(600),
      searchKeys: arraySchema(boundedString(80), { minItems: 1, maxItems: 8 }),
      check: objectSchema({ kind: enumSchema(CHECK_KINDS), text: boundedString(300) }, ['kind', 'text'])
    }, ['taskContextToken', 'origin', 'title', 'solution', 'searchKeys'])
  }
];
