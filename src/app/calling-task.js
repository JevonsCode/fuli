import { activeAgentHostClient } from './agent-request-context.js';
import { requiredString } from '../validation/values.js';

const TOKEN_LIMIT = 256;

// The task an Agent call's current taskContextToken names, resolved for the
// client the call came from (its host's, else the payload's). Who is calling
// (FLA, project, client, session) comes from that task, never from arguments.
export function callingTask(app, input) {
  const token = requiredString(input?.taskContextToken, 'taskContextToken', TOKEN_LIMIT);
  return app.taskContextRegistry.context(token, activeAgentHostClient() ?? input.sourceApplication ?? 'other');
}
