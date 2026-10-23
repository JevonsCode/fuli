import { projectByName, projectNames } from './task-entry-project-mention.js';
import { ASSISTANT_AGENT_ID } from './task-entry-project-scope.js';
import { PROPOSAL_MIN_CONVERSATIONS, proposalForTopic } from './topic-proposals.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';

// Jefa's triage of conversations no project has claimed yet. The finishing
// host labels its own conversation while checkpointing; no model is called.
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
    if (!recorded.kept && label.kind === 'topic' && recorded.topic_count >= PROPOSAL_MIN_CONVERSATIONS) {
      const proposal = await proposalForTopic(application, recorded.triage.topic).catch(() => null);
      if (proposal) result.proposal = proposal;
    }
    return result;
  } catch {
    return { status: 'unavailable', reason: 'triage_unavailable' };
  }
}

// The conversation's current label or null; labeled_at is its version.
export async function readConversationTriage(application, conversationId) {
  return (await application.personal.conversationTriage('read', {
    personal_space_id: application.config.personal.spaceId, conversation_id: conversationId })).triage;
}

// A person's correction from the pages. It is stored as source user, so a
// later host label never overwrites it; no project is formed on the user's behalf.
export async function recordUserTriage(application, input) {
  const label = validateTriage({ kind: input.kind, project: input.personalProjectId, topic: input.topic });
  return application.personal.conversationTriage('record', {
    personal_space_id: application.config.personal.spaceId, conversation_id: input.conversationId,
    kind: label.kind, personal_project_id: label.kind === 'project' ? input.personalProjectId : null,
    topic: label.kind === 'topic' ? label.topic : null, source: 'user'
  });
}

function invalid(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
