import { ApplicationError } from '../app/application-error.js';
import { callingFla } from '../app/calling-task.js';

// Who submits an Agent app: the FLA the caller's current task is bound to,
// read from its taskContextToken like a workflow's owner, never taken on the
// caller's word. An agentId or personalSpaceId the caller still passes must
// name that same FLA and space, or the submission is refused: one FLA cannot
// put a version under another FLA's name, where the person would read the
// wrong submitter when they confirm it.
// Returns callingFla's owner, project included, so what the submission settles
// (agent-workflows/agent-tools.js appSubmitted) is that same FLA's, in that project.
export async function callingAppOwner(app, input) {
  const owner = await callingFla(app, input, { what: 'An Agent app belongs to an FLA' });
  const { personalSpaceId, agentId } = owner;
  if (input.personalSpaceId != null && input.personalSpaceId !== personalSpaceId) {
    throw new ApplicationError('scope_mismatch', 'personalSpaceId is not the space of this task', { status: 403 });
  }
  if (input.agentId != null && input.agentId !== agentId) {
    throw new ApplicationError('agent_not_owner',
      'An app is submitted in the name of the FLA whose task this is; leave agentId out or pass that FLA', { status: 403 });
  }
  return owner;
}
