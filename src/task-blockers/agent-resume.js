import { DELEGATION_HANDLERS } from '../agent-delegation/agent-tool.js';
import { ApplicationError } from '../app/application-error.js';
import { callingTask } from '../app/calling-task.js';
import { utf8Preview } from '../text/utf8-preview.js';
import { RESUME_STATUSES } from './resume-status.js';

// rec#123: an Agent that fixed what blocked a task from another session
// resumes it in one record_project_agent_task_activity call. The Provider
// refuses that report (only the reporting session or the lead moves a block
// on); this module then makes the same clear run_delegated_action makes on the
// blocker/clear route, so the person's AI permissions (Settings › AI
// permissions › Organisation) decide it at the console's delegation gate and
// its operation log records it with the Agent and its reason, and then records
// the report. With that permission off nothing is cleared and the refusal
// names the switch. The reporting session and the lead never reach this path.
const BLOCKED_ELSEWHERE = 'task_blocked_elsewhere';
const CLEAR_ROUTE = 'POST /api/project-agent-tasks/:taskId/blocker/clear';
const REASON_LIMIT = 500;
const NOTHING_DONE = 'The block was not cleared and the report was not recorded. ';
const TOKEN_NEEDED = 'Blocked by another session. Resend with your taskContextToken and FULI clears the block '
  + 'under the person\'s AI permission (Settings › AI permissions › Organisation), then records this report.';

export async function recordTaskActivityResumingBlock(app, input) {
  try {
    return await app.recordProjectAgentTaskActivity(input);
  } catch (error) {
    if (error?.code !== BLOCKED_ELSEWHERE || !RESUME_STATUSES.has(input?.status)) throw error;
    if (!input.taskContextToken) throw new ApplicationError(BLOCKED_ELSEWHERE, TOKEN_NEEDED, { status: 409 });
    return resumeAndRecord(app, input);
  }
}

async function resumeAndRecord(app, input) {
  const task = await callingTask(app, input);
  if (input.expectedRevision != null) {
    // A stale report clears nothing: the Agent reads the task again first.
    const current = await app.viewProjectAgentTask({ personalSpaceId: input.personalSpaceId,
      personalProjectId: input.personalProjectId, taskId: input.taskId, includeEvents: false });
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationError('task_revision_stale', `${NOTHING_DONE}Task revision is ${current.revision}, `
        + `not ${input.expectedRevision}; read the task again and retry.`, { status: 409 });
    }
  }
  let cleared;
  try {
    cleared = await DELEGATION_HANDLERS.run_delegated_action(app, {
      taskContextToken: input.taskContextToken, sourceApplication: input.sourceApplication,
      route: CLEAR_ROUTE, params: { taskId: input.taskId },
      body: { personalSpaceId: input.personalSpaceId, personalProjectId: input.personalProjectId,
        resumeStatus: input.status },
      reason: utf8Preview(input.summary, REASON_LIMIT, text => text.length)
    });
  } catch (refusal) {
    throw new ApplicationError(refusal.code ?? 'delegated_change_failed', NOTHING_DONE + refusal.message,
      { status: refusal.status ?? 409 });
  }
  const recorded = await app.recordProjectAgentTaskActivity(input.expectedRevision == null
    ? input : { ...input, expectedRevision: cleared.result.revision });
  return { ...recorded, blockerCleared: {
    by: { agentId: task.projectAgentId ?? null, client: task.sourceApplication ?? null, sessionId: task.sessionId ?? null },
    permission: 'Settings › AI permissions › Organisation', operationId: cleared.operationId,
    resumedAs: input.status, receipt: cleared.delegation_receipt
  } };
}
