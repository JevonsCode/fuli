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
const REPORT_REFUSED_AFTER_CLEAR = 'task_report_refused_after_clear';
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

// The Provider refuses a blocked task's report for being blocked only after
// every other check of that report passed (lead, participant, client,
// revision), so the clear happens only for a report that will be recorded. The
// clear carries the revision the refusal was for, so a block reported again
// in between is not cleared. If the report still fails after the clear, the
// Agent is told plainly that the block was cleared, by whom and in which
// record, and that its report was not.
async function resumeAndRecord(app, input) {
  const task = await callingTask(app, input);
  const expectedRevision = input.expectedRevision ?? (await app.viewProjectAgentTask({
    personalSpaceId: input.personalSpaceId, personalProjectId: input.personalProjectId, taskId: input.taskId,
    includeEvents: false })).revision;
  let cleared;
  try {
    cleared = await DELEGATION_HANDLERS.run_delegated_action(app, {
      taskContextToken: input.taskContextToken, sourceApplication: input.sourceApplication,
      route: CLEAR_ROUTE, params: { taskId: input.taskId },
      body: { personalSpaceId: input.personalSpaceId, personalProjectId: input.personalProjectId,
        resumeStatus: input.status, expectedRevision },
      reason: utf8Preview(input.summary, REASON_LIMIT, text => text.length)
    });
  } catch (refusal) {
    throw new ApplicationError(refusal.code ?? 'delegated_change_failed', NOTHING_DONE + refusal.message,
      { status: refusal.status ?? 409 });
  }
  const by = { agentId: task.projectAgentId ?? null, client: task.sourceApplication ?? null, sessionId: task.sessionId ?? null };
  let recorded;
  try {
    recorded = await app.recordProjectAgentTaskActivity(input.expectedRevision == null
      ? input : { ...input, expectedRevision: cleared.result.revision });
  } catch (refused) {
    throw new ApplicationError(REPORT_REFUSED_AFTER_CLEAR, `The block WAS cleared (record ${cleared.operationId ?? '-'}, `
      + `by ${by.agentId ?? by.client ?? 'this session'}) and the task is ${cleared.result?.status ?? input.status}; `
      + `this report was NOT recorded: ${refused.message}`, { status: refused.status ?? 409 });
  }
  return { ...recorded, blockerCleared: {
    by, permission: 'Settings › AI permissions › Organisation', operationId: cleared.operationId,
    resumedAs: input.status, receipt: cleared.delegation_receipt
  } };
}
