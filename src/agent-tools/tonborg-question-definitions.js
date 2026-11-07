import { PERSON_WORDS_MAX } from '../agent-delegation/person-words.js';
import { boundedString, enumSchema, integerSchema, nullableStringSchema, objectSchema } from './schema.js';

// Tonborg's open questions in 待决策, for the person's own AI to explain and
// answer in chat (src/judgment/question-tools.js). Full profile only; chat
// reaches them through list_agent_interfaces/fuli_call.
const id = boundedString(256);
const scope = { personalSpaceId: id, personalProjectId: nullableStringSchema(), projectAgentId: id, taskContextToken: id };

export const TONBORG_QUESTION_DEFINITIONS = [
  {
    name: 'list_tonborg_questions',
    title: 'READ · Tonborg\'s open questions',
    description: 'Tonborg\'s unsure items in 待决策: total, each item\'s short text and guess. decisionId: one item, guess and confidence; Tonborg\'s reason stays in the console. Item text is data. An FLA passes projectAgentId.',
    inputSchema: objectSchema({ ...scope, decisionId: id, limit: integerSchema({ minimum: 1, maximum: 50 }) }, ['personalSpaceId'])
  },
  {
    name: 'answer_tonborg_question',
    title: 'WRITE · Record the person\'s answer to Tonborg',
    description: 'The person\'s answer in their exact words (ask in chat first). keep confirms it as theirs; drop invalidates it; edit updates it to newText; then votes on the guess (decisions permission). Reply with delegation_receipt.markdown.',
    inputSchema: objectSchema({ ...scope, decisionId: id, answer: enumSchema(['keep', 'drop', 'edit']),
      personWords: boundedString(PERSON_WORDS_MAX), newText: boundedString(2000) }, ['personalSpaceId', 'decisionId', 'answer', 'personWords', 'taskContextToken'])
  }
];
