import { activeAgentHostClient } from '../app/agent-request-context.js';
import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';

const TOKEN_LIMIT = 256;
const ACTIONS = new Set(['register', 'update']);

// report_agent_service: an Agent records a server it started from its client
// session, or updates one it recorded. The owner (FLA, project, client and
// session) comes from the task its current taskContextToken names, never from
// arguments. Stopping, deleting and reading logs stay with the person (rec#11 D-71).
export async function reportAgentService(app, input) {
  if (!app.agentServices) {
    throw new ApplicationError('agent_services_unavailable', 'Services need a local FULI installation', { status: 503 });
  }
  if (!ACTIONS.has(input?.action)) throw new InvalidInputError('action must be register or update');
  const token = requiredString(input.taskContextToken, 'taskContextToken', TOKEN_LIMIT);
  const task = await app.taskContextRegistry.context(token, activeAgentHostClient() ?? input.sourceApplication ?? 'other');
  const owner = { personalSpaceId: app.config.personal.spaceId, agentId: task.projectAgentId ?? null,
    projectId: task.personalProjectId ?? null, client: task.sourceApplication ?? null, sessionId: task.sessionId };
  return input.action === 'register' ? app.agentServices.register(owner, input) : app.agentServices.update(owner, input);
}
