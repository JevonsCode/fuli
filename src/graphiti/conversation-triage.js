import { createProjectNamed, projectByName, projectNames } from './task-entry-project-mention.js';
import { ASSISTANT_AGENT_ID } from './task-entry-project-scope.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';

// Jefa's triage of conversations no project has claimed yet. The finishing
// host labels its own conversation while checkpointing; no model is called.
export const TOPIC_FORMATION_THRESHOLD = 3;
const PROJECT_CANDIDATES = 12;
const TOPIC_CANDIDATES = 8;
const KINDS = new Set(['project', 'topic', 'one_off']);

export function isUnclaimedTask(task) {
  return task?.projectAgentId === ASSISTANT_AGENT_ID && !task.personalProjectId;
}

// Names only, one per line in spirit: the entry stays small and details stay queryable.
export async function triageCandidates(application) {
  const [projects, topics] = await Promise.all([
    projectNames(application, PROJECT_CANDIDATES).catch(() => []),
    Promise.resolve().then(() => application.personal.conversationTriage('topics', {
      personal_space_id: application.config.personal.spaceId, limit: TOPIC_CANDIDATES
    })).then(value => value.topics.map(item => item.topic)).catch(() => [])
  ]);
  return { projects, topics, label_with: 'checkpoint_task_knowledge.triage' };
}

export function validateTriage(triage) {
  if (triage === null || triage === undefined) return null;
  const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
  if (!KINDS.has(triage?.kind)) throw invalid('triage.kind must be project, topic or one_off');
  const label = { kind: triage.kind, project: text(triage.project), topic: text(triage.topic) };
  if ((label.kind === 'project') !== Boolean(label.project)) throw invalid('Only a project label names triage.project');
  if ((label.kind === 'topic') !== Boolean(label.topic)) throw invalid('Only a topic label names triage.topic');
  return label;
}

// Never fails the checkpoint: a missing assistant, Provider or project only
// leaves the conversation pending, and the result says so.
export async function recordTriage(application, task, conversation, label) {
  if (!label) return null;
  if (!isUnclaimedTask(task)) return { status: 'not_applicable', reason: 'conversation_already_claimed' };
  if (!conversation?.conversation_id) return { status: 'not_recorded', reason: 'conversation_not_saved' };
  const spaceId = application.config.personal.spaceId;
  try {
    let projectId = null;
    if (label.kind === 'project') {
      const named = await projectByName(application, label.project);
      if (!named || named.ambiguous) return { status: 'not_recorded',
        reason: named ? 'project_name_ambiguous' : 'project_not_found' };
      projectId = named.personalProjectId;
    }
    const recorded = await application.personal.conversationTriage('record', {
      personal_space_id: spaceId, conversation_id: conversation.conversation_id, kind: label.kind,
      personal_project_id: projectId, topic: label.kind === 'topic' ? label.topic : null, source: 'host'
    });
    const result = { status: 'recorded', recorded_by: 'employee.jefa', ...recorded.triage,
      ...(recorded.kept ? { kept: recorded.kept } : {}) };
    if (!recorded.kept && label.kind === 'topic' && recorded.topic_count >= TOPIC_FORMATION_THRESHOLD) {
      result.formed = await formTopicProject(application, task, recorded.triage.topic, recorded.topic_count);
    }
    return result;
  } catch {
    return { status: 'unavailable', reason: 'triage_unavailable' };
  }
}

// A topic that keeps coming back becomes a project: an AI-draft brief, a lead
// staffed through AR, and its conversations attached. People can rename,
// merge, split or return it afterwards.
async function formTopicProject(application, task, topic, count) {
  const spaceId = application.config.personal.spaceId;
  const reason = `话题「${topic}」累计 ${count} 个会话，Jefa 自动立项`;
  const existing = await projectByName(application, topic);
  if (existing?.ambiguous) return { status: 'not_formed', reason: 'project_name_ambiguous' };
  const project = existing ?? await createProjectNamed(application, topic, `${reason}（AI 草稿，可编辑）`);
  const projectId = project.personalProjectId;
  const lead = await application.personal.staffDefaultProjectLead({ personal_space_id: spaceId,
    personal_project_id: projectId, source_application: task.sourceApplication ?? 'other' })
    .catch(() => null);
  const attached = await application.personal.conversationTriage('form', {
    personal_space_id: spaceId, topic, personal_project_id: projectId });
  return { status: 'formed', personal_project_id: projectId, automatic: true, reason,
    lead_agent_id: lead?.agent?.agent_id ?? null, conversations: attached.conversation_ids.length };
}

function invalid(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
