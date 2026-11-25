import { PERSON_WORDS_MAX } from '../agent-delegation/person-words.js';
import { boundedString, objectSchema } from './schema.js';

// One tool for every console change the person lets FLAs make for them
// (rec#11 D-81). Full profile only; chat reaches it through
// list_agent_interfaces/fuli_call. The routes are the catalog's
// agent_delegable, agent_delegable_off and agent_relayed entries.
export const DELEGATION_DEFINITIONS = [
  {
    name: 'run_delegated_action',
    title: 'WRITE · Make a console change for the person',
    description: 'When asked or needed, call a permitted list_agent_interfaces route with :params, console JSON body and reason. agent_relayed requires the person’s exact reply in personWords. Respect local_user_only, disabled AI permissions and person_words_not_found. Return delegation_receipt.markdown.',
    inputSchema: objectSchema({
      taskContextToken: boundedString(256),
      route: boundedString(300),
      params: { type: 'object', additionalProperties: boundedString(512), description: 'Values for :params.' },
      body: { type: 'object', additionalProperties: true },
      reason: boundedString(500),
      personWords: boundedString(PERSON_WORDS_MAX)
    }, ['taskContextToken', 'route', 'reason'])
  },
  {
    name: 'hand_off_to_client',
    title: 'WRITE · Hand work to another client',
    description: 'Roundtable handoff. Retry with requestId; query or acknowledge with handoffId.',
    inputSchema: objectSchema({
      taskContextToken: boundedString(256),
      action: { type: 'string', enum: ['open', 'status', 'acknowledge'] },
      client: boundedString(64), projectPath: boundedString(4096), prompt: boundedString(2000),
      model: boundedString(100), requestId: boundedString(128), handoffId: boundedString(100)
    }, ['taskContextToken', 'action'])
  }
];
