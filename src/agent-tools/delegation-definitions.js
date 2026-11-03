import { boundedString, objectSchema } from './schema.js';

// One tool for every console change the person lets FLAs make for them
// (rec#11 D-81). Full profile only; chat reaches it through
// list_agent_interfaces/fuli_call. The routes are the catalog's
// agent_delegable and agent_delegable_off entries.
export const DELEGATION_DEFINITIONS = [
  {
    name: 'run_delegated_action',
    title: 'WRITE · Make a console change for the person',
    description: 'Runs one agent_delegable/agent_delegable_off route from list_agent_interfaces for the person, when they ask or the task needs it. Exact route, its :params, the JSON body the console page sends, why. Refused for local_user_only routes and while its category is off: then tell the person to turn it on in Settings › AI permissions. Recorded with who, task and undo; put delegation_receipt.markdown in your reply.',
    inputSchema: objectSchema({
      taskContextToken: boundedString(256),
      route: boundedString(300),
      params: { type: 'object', additionalProperties: boundedString(512), description: 'Value of each :param in route.' },
      body: { type: 'object', additionalProperties: true },
      reason: boundedString(500)
    }, ['taskContextToken', 'route', 'reason'])
  }
];
