import { ApplicationError } from '../app/application-error.js';
import { callingTask } from '../app/calling-task.js';

// Who submits an Agent app: the FLA the caller's current task is bound to,
// read from its taskContextToken like a workflow's owner, never taken on the
// caller's word. An agentId or personalSpaceId the caller still passes must
// name that same FLA and space, or the submission is refused: one FLA cannot
// put a version under another FLA's name, where the person would read the
// wrong submitter when they confirm it.
export async function callingAppOwner(app, input) {
  const task = await callingTask(app, input);
  if (!task.projectAgentId) {
    throw new ApplicationError('agent_not_bound', 'An Agent app belongs to an FLA; this task is not bound to one', { status: 409 });
  }
  const personalSpaceId = app.config.personal.spaceId;
  if (input.personalSpaceId != null && input.personalSpaceId !== personalSpaceId) {
    throw new ApplicationError('scope_mismatch', 'personalSpaceId is not the space of this task', { status: 403 });
  }
  if (input.agentId != null && input.agentId !== task.projectAgentId) {
    throw new ApplicationError('agent_not_owner',
      'An app is submitted in the name of the FLA whose task this is; leave agentId out or pass that FLA', { status: 403 });
  }
  return { personalSpaceId, agentId: task.projectAgentId };
}
