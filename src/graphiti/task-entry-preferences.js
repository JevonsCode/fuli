import { captureSettingsUrl, taskAgentReceipt } from '../agents/identity-receipt.js';
import { beginTaskContext, beginTaskFromPreferences } from './agent-knowledge-workflows.js';
import { getCollaborationPreferences as getCollaborationPreferencesWorkflow } from './collaboration-preference-workflow.js';
import { resolveTaskEntryAgent, loadProjectAgentContinuity } from './project-agent-task-entry.js';
import { applyAgentAssignment } from './task-agent-assignment.js';
import { triageCandidates } from './conversation-triage.js';
import { withProjectCandidate } from './assistant-project-candidate.js';
import { withBoardMatch } from './jefa-board-match.js';
import { ASSISTANT_AGENT_ID } from './task-entry-project-scope.js';
import { ATTENTION_REPLIES_GUIDANCE } from '../../packages/roundtable/src/roundtable/attention-inbox.js';
import { captureDecision } from './capture-decision.js';
import { receiptNotices } from './capture-notice.js';
import { receiptFormatNotices } from '../data-format/format-notices.js';
import { noteEntryTask } from '../conversations/entry-budget.js';
import { withSharedProjectList } from './shared-project-list.js';
import { standingOwnerEntry } from './task-entry-standing-owner.js';

export async function finishTaskEntryPreferences(application, preferences, input) {
  if (!input.agentInvocation || input.agentToolName !== 'get_collaboration_preferences') return preferences;
  if (!input.sessionId || typeof input.taskPrompt !== 'string') return { ...preferences,
    task_lifecycle: { status: 'not_started', reason: !input.sessionId ? 'native_session_required' : 'task_prompt_required',
      guidance: 'Preferences were loaded, but no task token was created. Supply the current host sessionId and taskPrompt to get_collaboration_preferences. Do not guess a session ID, use an MCP process ID or reuse an earlier task token.' } };
  return withEntryHint(application, await beginTaskFromPreferences(application, preferences, input), input);
}

// begin_task_context and the lifecycle hooks: the same hints, once per session each.
// The entry reads its project list once (shared-project-list.js), already
// while the session's current task is looked up.
export function beginTaskEntry(application, input) {
  return withSharedProjectList(async () => {
    if (input.projectPath !== undefined && input.projectPath !== null) application.listPersonalProjects().catch(() => {});
    const entry = await beginTaskContext(application, input);
    // Its task and opening writes are done: a hook deadline from here on
    // delivers the token instead of nothing (entry-budget.js).
    noteEntryTask(entry);
    return withEntryHint(application, entry, input);
  });
}

// At most one built-in Agent model decision per entry (rec#10 D-26.2): Astro
// while the task has no project, Jefa once the task has one.
function withEntryHint(application, entry, input) {
  return entry.context?.personal_project_id ? withBoardMatch(application, entry, input) : withProjectCandidate(application, entry, input);
}

export async function taskEntryPreferences(application, projectResolution, input, recordAgentViews) {
  const { projectAgentId, taskPrompt, sourceApplication, sourceSessionId, sessionId,
    turnId, workKind, requiredCapabilities, agentInvocation, agentToolName } = input;
  // What does not depend on the Agent is read while it is selected (rec#39 D-40).
  const reads = agentIndependentReads(application, projectResolution, input);
  const selection = await resolveTaskEntryAgent(
      application, projectResolution, { projectAgentId, taskPrompt, sourceApplication,
        sessionId: agentToolName === 'get_collaboration_preferences'
          ? sessionId ?? sourceSessionId : turnId ? sessionId : null,
        receivingSessionId: sessionId ?? sourceSessionId,
        turnId: agentToolName === 'begin_task_context' ? turnId : null,
        workKind, requiredCapabilities, agentInvocation, agentToolName }
    );
  return entryPreferences(application, projectResolution, input, selection, recordAgentViews, reads);
}

// Selection/admission belongs to the caller; preference and continuity projection is shared.
export function selectedTaskEntryPreferences(application, projectResolution, input, selection, recordAgentViews,
  { includeManagement = true, includeMessages = true } = {}) {
  return entryPreferences(application, projectResolution, input, selection, recordAgentViews,
    agentIndependentReads(application, projectResolution, input, { includeManagement }), { includeManagement, includeMessages });
}

// Started before they are awaited; a failure is reported where it was before.
function agentIndependentReads(application, projectResolution, { sourceApplication, sourceSessionId, sessionId,
  agentInvocation, agentToolName }, { includeManagement = true } = {}) {
  const reads = {
    management: includeManagement && projectResolution.personalProjectId && application.employees && agentInvocation &&
      ['begin_task_context', 'get_collaboration_preferences'].includes(agentToolName)
      ? Promise.resolve(application.employees.taskEntry({ personalProjectId: projectResolution.personalProjectId,
        sourceApplication, sourceSessionId, sessionId }))
      : Promise.resolve(null),
    // The entry receipt says when automatic recording is off, and that a project
    // the person asked for was still created (rec#11 D-01). The task begins in
    // this project, so the receipt gives the decision its writes will get.
    capture: captureDecision(application, { sourceApplication,
      personalProjectId: projectResolution.personalProjectId ?? null, sessionId: sessionId ?? sourceSessionId }),
    formatNotices: receiptFormatNotices(application)
  };
  for (const read of Object.values(reads)) read.catch(() => {});
  return reads;
}

// Reads that need neither each other nor the preferences run together; the
// team and judgment wait only for the management answer that decides them.
async function entryPreferences(application, projectResolution, {
  projectAgentId, taskPrompt, sourceApplication, sourceSessionId, sessionId,
  workKind, workflow, limit, agentInvocation, agentToolName
}, selection, recordAgentViews, reads, { includeManagement = true, includeMessages = true } = {}) {
  // A rejected explicit role must not leak its private preferences via fallback.
  const selectedAgentId = selection ? selection.agent?.agentId ?? null : projectAgentId;
  const standing = standingOwnerEntry(projectResolution, selection);
  const team = reads.management.then(management => {
    // Sealed workers already carry a coordinator's reporting contract. Ordinary
    // entry advertises team/judgment only with an available authorized manager.
    const includeTeam = !includeManagement || (management?.status !== 'degraded'
      && Array.isArray(management?.managers) && management.managers.length > 0);
    return Promise.all([
      selection?.agent ? loadProjectAgentContinuity(application, {
        projectId: projectResolution.personalProjectId, agent: selection.agent,
        sourceApplication, taskPrompt, selectionReason: selection.reason,
        matchBasis: standing?.matchBasis ? [...(selection.match_basis ?? []), standing.matchBasis] : selection.match_basis,
        includeTeam
      }) : selection,
      includeTeam ? taskJudgmentContext(application, projectResolution.personalProjectId) : null
    ]);
  });
  const [preferences, management, [context, judgmentContext], triage, capture, formatNotices] = await Promise.all([
    getCollaborationPreferencesWorkflow(
      application,
      projectResolution,
      {
        projectAgentId: selectedAgentId,
        taskPrompt,
        sessionId,
        sourceSessionId,
        workKind,
        workflow,
        limit,
        agentInvocation,
        agentToolName,
        sourceApplication
      },
      (items, toolName) => recordAgentViews(items, toolName)
    ),
    reads.management,
    team,
    // An unclaimed conversation gets names only, so its finishing host can label it.
    selection?.agent?.agentId === ASSISTANT_AGENT_ID && !projectResolution.personalProjectId
      ? triageCandidates(application) : null,
    reads.capture,
    reads.formatNotices
  ]);
  const managedPreferences = management ? { ...preferences, project_management_context: management } : preferences;
  if (context) applyAgentAssignment(context, selection);
  // Questions other Agents left for this Agent while it was not running.
  const waiting = includeMessages && selection?.agent && application.roundtable
    ? application.roundtable.pending(selection.agent.agentId, projectResolution.personalProjectId) : [];
  // Answers a person gave to this Agent's own requests while it was away.
  const answered = includeMessages && selection?.agent && projectResolution.personalProjectId && application.roundtable?.attentionReplies
    ? application.roundtable.attentionReplies(selection.agent.agentId, projectResolution.personalProjectId) : [];
  const notices = [...(standing?.notice ? [standing.receiptNotice] : []), ...receiptNotices(capture, projectResolution.basis === 'created_from_prompt' ? ['project_created'] : [],
    { settingsUrl: captureSettingsUrl(application) }), ...formatNotices];
  return { ...managedPreferences, ...(context ? { project_agent_context: context } : {}),
    ...(triage ? { triage_candidates: triage } : {}),
    ...(standing ? { standing_owner: standing.field } : {}),
    ...(judgmentContext ? { judgment_context: judgmentContext } : {}),
    ...(waiting.length ? { agent_messages: waiting,
      agent_messages_guidance: 'Other Agents are waiting for your answers. Reply to each with reply_agent_message.' } : {}),
    ...(answered.length ? { attention_replies: answered, attention_replies_guidance: ATTENTION_REPLIES_GUIDANCE } : {}),
    agent_receipt: taskAgentReceipt(application, {
      projectId: projectResolution.personalProjectId, agentId: selection?.agent?.agentId ?? null,
      name: context?.role?.name, role: selection?.agent?.profile?.name, sourceApplication,
      assignmentStatus: selection?.status, assignmentReason: selection?.reason, notices
    }) };
}

export async function taskJudgmentContext(application, personalProjectId) {
  const judgmentPolicy = await application.judgment?.policy({ personalSpaceId: application.config.personal.spaceId,
    personalProjectId: personalProjectId ?? null });
  return judgmentPolicy ? { agentId: 'employee.tonborg', policy: judgmentPolicy,
      guidance: judgmentPolicy.mode === 'manual'
        ? 'Tonborg is available for advice via assess_agent_action; retain human review.'
        : 'Before choosing a new subagent, session, client or model, use assess_agent_action with the exact project, Agent and task. Use its eligible recommendation within the saved policy; recheck host capability before dispatch. Do not ask again for an already delegated routine choice. Escalations, user rules and locked executor policies still apply. For an awaiting-review FULI task, its accountable lead can use assess_task_completion with exact task/artifact revision and real verification evidence. Jefa human acceptance and external publication remain separate. Recommendations are not permissions or execution receipts.' } : null;
}
