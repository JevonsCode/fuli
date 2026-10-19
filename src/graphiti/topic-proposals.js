import { createProjectNamed, projectByName } from './task-entry-project-mention.js';
import { sourceConsoleUrl } from './source-marker.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';

// Astro's suggestion to give a recurring topic its own project. A topic that
// keeps coming back over several days is proposed, never formed on its own:
// the person decides in the console, and "not yet" waits for more conversations.
// Every rule reads stored triage counts; no model is called.
export const PROPOSAL_MIN_CONVERSATIONS = 3;
export const PROPOSAL_MIN_DAYS = 2;
export const PROPOSAL_ASK_AGAIN_AFTER = 3;
const PROPOSAL_LIMIT = 20;

export function isProposable(stats) {
  if (!stats || stats.count < PROPOSAL_MIN_CONVERSATIONS || (stats.days ?? 0) < PROPOSAL_MIN_DAYS) return false;
  return stats.declined_count == null || stats.count >= stats.declined_count + PROPOSAL_ASK_AGAIN_AFTER;
}

export async function listTopicProposals(application) {
  const value = await topics(application, { limit: PROPOSAL_LIMIT });
  return { proposals: value.filter(isProposable).map(proposalView) };
}

// For the conversation that was just labelled: the host asks the person at the
// end of its reply, once every few conversations, so an open card never nags.
export async function proposalForTopic(application, topic) {
  const [stats] = await topics(application, { topic, limit: 1 });
  if (!isProposable(stats) || (stats.count - (stats.declined_count ?? 0)) % PROPOSAL_ASK_AGAIN_AFTER !== 0) return null;
  const url = `${application.consoleUrl ?? sourceConsoleUrl(null)}/employees/assistant`;
  return { status: 'ask_user', proposed_by: 'employee.assistant', ...proposalView(stats), console_url: url,
    ask_user: `「${stats.topic}」已经聊了 ${stats.count} 次、跨 ${stats.days} 天，还没成立项目。`
      + `要为它成立项目、招人长期维护吗？请在 FULI 控制台决定：${url}`,
    guidance: 'Add ask_user to the end of your reply. Only the person decides, in the console; never form the project yourself.' };
}

// The person said yes: an AI-draft brief, a lead staffed through AR, and every
// open conversation of the topic attached. The lead hires more people only when
// the work needs them. People can rename, merge or split it afterwards.
export async function acceptTopicProposal(application, { topic, sourceApplication = 'other' }) {
  const stats = await openTopic(application, topic);
  const spaceId = application.config.personal.spaceId;
  const reason = `你同意了 Astro 的建议：话题「${stats.topic}」累计 ${stats.count} 个会话、跨 ${stats.days} 天`;
  const existing = await projectByName(application, stats.topic);
  if (existing?.ambiguous) throw new ApplicationError(ApplicationErrorCode.VALIDATION,
    `More than one project is named ${stats.topic}; move the conversations to one of them instead`);
  const project = existing ?? await createProjectNamed(application, stats.topic, `${reason}（AI 草稿，可编辑）`);
  const projectId = project.personalProjectId;
  const lead = await application.personal.staffDefaultProjectLead({ personal_space_id: spaceId,
    personal_project_id: projectId, source_application: sourceApplication }).catch(() => null);
  const attached = await application.personal.conversationTriage('form', {
    personal_space_id: spaceId, topic: stats.topic, personal_project_id: projectId });
  return { status: 'formed', personal_project_id: projectId, topic: stats.topic, reason,
    lead_agent_id: lead?.agent?.agent_id ?? null, lead_status: lead?.status ?? 'unavailable',
    conversations: attached.conversation_ids.length };
}

export async function declineTopicProposal(application, { topic }) {
  await openTopic(application, topic);
  const declined = await application.personal.conversationTriage('decline', {
    personal_space_id: application.config.personal.spaceId, topic });
  return { status: 'declined', topic: declined.topic, declined_count: declined.declined_count,
    ask_again_at: declined.declined_count + PROPOSAL_ASK_AGAIN_AFTER };
}

async function openTopic(application, topic) {
  const name = typeof topic === 'string' ? topic.trim() : '';
  if (!name) throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'A topic is required');
  const [stats] = await topics(application, { topic: name, limit: 1, minCount: 1 });
  if (!stats) throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, 'No open conversation has this topic');
  return stats;
}

async function topics(application, { topic = null, limit, minCount = PROPOSAL_MIN_CONVERSATIONS }) {
  const value = await application.personal.conversationTriage('topics', {
    personal_space_id: application.config.personal.spaceId, limit, min_count: minCount,
    ...(topic ? { topic } : {}) });
  return value.topics;
}

function proposalView(stats) {
  return { topic: stats.topic, conversations: stats.count, days: stats.days,
    last_labeled_at: stats.last_labeled_at ?? null, declined_count: stats.declined_count ?? null };
}
