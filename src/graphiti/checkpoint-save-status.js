import { ProviderRequestError } from './provider-client.js';
import { isProviderOutage } from './provider-outage.js';

// A checkpoint FULI's graph service did not save is a status the Agent acts
// on, not a bare error.
//
// rec#39: the first checkpoint call binds its input, so a call the Graph
// Provider never answered finishes only when resent unchanged. Say so instead
// of a bare timeout, which led Agents to retry with new wording and be refused.
const INCOMPLETE_GUIDANCE = 'This checkpoint did not finish because FULI\'s graph service did not answer. ' +
  'FULI may already keep its input, so retry checkpoint_task_knowledge with exactly the same arguments; changed wording is refused. ' +
  'Until a retry returns checkpointed, do not claim the task was saved; end with the entry agent_receipt. ' +
  'If the retry fails again, say in one line that FULI could not save this task yet.';

// rec#110 item 8: a token the Provider does not know for this client
// (another client's, superseded or expired) or may not use, refused when the
// checkpoint first reads its task, before it writes anything: this call saved
// nothing, on the Provider or on this computer. The content is still in the
// Agent's conversation, so it is resent from there. A 403/404 after writing
// began (a later turn superseded the task between prepare and complete) is
// not this case and fails as before (DOT on #880). Fixed text only: the
// Provider's message is not forwarded.
const TOKEN_REFUSALS = new Set([403, 404]);
const admissionRefusals = new WeakSet();
const NOT_SAVED_GUIDANCE = 'FULI did not save this checkpoint: this connection cannot use its taskContextToken ' +
  '(another client\'s, superseded or expired, or not allowed here), so this call saved nothing. Tell the person in one line ' +
  'that this task\'s knowledge is not saved in FULI yet. Now, in this conversation, call get_collaboration_preferences ' +
  'through this connection for a token of its own and call checkpoint_task_knowledge again with that token and the same ' +
  'content. An amend:true correction belongs to its own task and cannot move to another.';

function checkpointIncomplete(error) {
  return {
    status: 'checkpoint_incomplete',
    reason: error.code,
    checkpoint_required: true,
    retry: { tool: 'checkpoint_task_knowledge', same_input: true, attempts: 1 },
    guidance: INCOMPLETE_GUIDANCE
  };
}

function checkpointNotSaved(error) {
  return {
    status: 'checkpoint_not_saved',
    reason: 'task_token_refused',
    http_status: error.status,
    checkpoint_required: true,
    retry: { tool: 'checkpoint_task_knowledge', same_content: true, new_token: true },
    guidance: NOT_SAVED_GUIDANCE
  };
}

// The checkpoint's first read of its task; a token refused here is marked as refused before any write.
export async function admittedTask(read) {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ProviderRequestError && TOKEN_REFUSALS.has(error.status)) admissionRefusals.add(error);
    throw error;
  }
}

// Runs the checkpoint; an outage or a token refused at admission becomes its status, anything else fails as before.
export async function withCheckpointSaveStatus(checkpoint) {
  try {
    return await checkpoint;
  } catch (error) {
    if (isProviderOutage(error)) return checkpointIncomplete(error);
    if (admissionRefusals.has(error)) return checkpointNotSaved(error);
    throw error;
  }
}
