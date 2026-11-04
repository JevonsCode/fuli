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
    description: 'One agent_delegable(_off)/agent_relayed route from list_agent_interfaces, when the person asks or the task needs it. Route, :params, the console page JSON body, why. agent_relayed: ask in chat, pass their exact words in personWords. Refused for local_user_only, a category turned off (Settings › AI permissions) or person_words_not_found. Reply with delegation_receipt.markdown.',
    inputSchema: objectSchema({
      taskContextToken: boundedString(256),
      route: boundedString(300),
      params: { type: 'object', additionalProperties: boundedString(512), description: 'Value of each :param in route.' },
      body: { type: 'object', additionalProperties: true },
      reason: boundedString(500),
      personWords: boundedString(PERSON_WORDS_MAX)
    }, ['taskContextToken', 'route', 'reason'])
  }
];
