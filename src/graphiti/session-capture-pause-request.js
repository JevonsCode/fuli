import { taskAgentReceipt } from '../agents/identity-receipt.js';
import { requiredString } from '../validation/values.js';
import { taskAgentName } from './agent-conversations.js';
import { captureDecision, taskCaptureScope } from './capture-decision.js';
import { receiptNotices } from './capture-notice.js';

// "这次别记" / "继续记" (rec#5 C3, C4-3): an Agent pauses or resumes automatic
// recording of the session it works in, on the person's word and without a
// confirmation, because nothing long-term changes. The session is the one the
// host bound to the current task, never a model-supplied ID, so every client
// pauses the same way. Nothing recorded before the pause is removed, and
// nothing written while paused is recorded after a resume.
const PAUSED_GUIDANCE = 'Recording of this session is paused from now on; earlier records stay. Do not checkpoint knowledge or describe anything from now on as saved. End this reply with this agent_receipt.';
const RESUMED_GUIDANCE = 'Recording of this session follows the capture settings again from now on; what was said while paused is not recorded. End this reply with this agent_receipt.';

export async function setSessionCapturePause(application, { taskContextToken, sessionPaused, sourceApplication = 'other',
  ...settings }) {
  if (Object.keys(settings).length) {
    throw new TypeError('sessionPaused changes only this session; send long-term settings in their own confirmed call');
  }
  if (typeof sessionPaused !== 'boolean') throw new TypeError('sessionPaused must be a boolean');
  const task = await application.taskContextRegistry.context(requiredString(taskContextToken, 'taskContextToken'),
    sourceApplication);
  const state = application.setSessionCapturePause(requiredString(task.sessionId, 'Task host session'),
    { paused: sessionPaused });
  // A resumed session may still be off by another layer; the receipt says so.
  const decision = await captureDecision(application, taskCaptureScope(task));
  return { status: sessionPaused ? 'session_paused' : 'session_resumed', paused: state.paused,
    since: state.since, captured: decision.allowed,
    agent_receipt: taskAgentReceipt(application, { projectId: task.personalProjectId,
      agentId: task.projectAgentId ?? null, name: await taskAgentName(application, task),
      sourceApplication: task.sourceApplication, notices: receiptNotices(decision) }),
    guidance: sessionPaused ? PAUSED_GUIDANCE : RESUMED_GUIDANCE };
}
