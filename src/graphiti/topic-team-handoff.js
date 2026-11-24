import { ASSISTANT_AGENT_ID } from '../employees/fixed-roles.js';
import { sha256Bytes } from '../security/digest.js';
import { singleLine } from '../text/single-line.js';

// When a topic grows into a project (topic-proposals.js), Astro hands the
// work over to the project's lead, and to nobody else: a new project starts
// with its lead alone (Jevons 11-17, replacing the first team of 11-11).
// Whoever else it needs is hired by Bole when a task finds nobody for it, and
// that hire asks no confirmation in a project Astro formed (rec#11 D-84). The
// handover is a task of the lead's own, assigned and not started, carrying
// the brief: an index (dates and one-line outcomes of the topic's
// conversations, how much knowledge moved); bodies stay where they are and are
// read on demand. Nothing here calls a model, and nothing here can undo the
// formation: a step that fails is reported.
const BRIEF_CONVERSATIONS = 8;
const OUTCOME_CHARS = 120;
const TOPIC_CHARS = 60;
const CONVERSATION_PAGE = 50;

// topic, projectId and lead come from the formation; conversationIds and
// knowledgeMoved from what it attached. Returns what the lead was handed, for
// the notice and the console.
export async function staffTopicTeam(application, { topic, projectId, lead, created, conversationIds, knowledgeMoved,
  sourceApplication = 'other' }) {
  const spaceId = application.config.personal.spaceId;
  const name = topic.slice(0, TOPIC_CHARS);
  const conversations = await topicConversations(application, conversationIds);
  const brief = handoffBrief(name, conversations, conversationIds.length, knowledgeMoved);
  // One handover per set of conversations: the same formation repeated is the
  // same tasks, and a topic that grows into the project again is a new handover.
  const formation = sha256Bytes(JSON.stringify([...conversationIds].sort())).slice(0, 16);
  const submit = async (position, body) => {
    try {
      return handed(position, await application.personal.submitProjectAgentTask({
        personal_space_id: spaceId, personal_project_id: projectId, duration: 'ongoing', start: false,
        source_application: sourceApplication, idempotency_key: `topic-handoff:${projectId}:${formation}:${position}`, ...body }));
    } catch { return { position, status: 'unavailable', agent_id: null, name: null, task_id: null }; }
  };

  const handoffs = [await submit('lead', { lead_agent_id: lead.agent_id, staffing_intent: 'reuse_preferred',
    work_kind: 'project_context', title: `接手「${name}」`, objective: brief,
    routing_reason: 'Astro hands the topic it looked after over to the project lead.' })];
  // A project that already had people keeps its own recruitment setting.
  if (created) await hireWithoutAsking(application, spaceId, projectId);
  return { handoffs, conversations: conversationIds.length, knowledge: knowledgeMoved };
}

// A project Astro just formed lets Bole hire without a confirmation each
// (rec#11 D-84); the person can turn asking back on in the project's
// settings. A policy that could not be saved leaves the project asking.
async function hireWithoutAsking(application, spaceId, projectId) {
  try {
    await application.personal.updateProjectAgentCoordinationPolicy({ personal_space_id: spaceId,
      personal_project_id: projectId, ask_before_recruitment: false });
  } catch { /* the project keeps asking before each hire */ }
}

function handed(position, route) {
  const agent = route?.assigned_agent ?? null;
  return { position, status: agent ? route.task?.status ?? 'assigned' : route?.decision ?? 'unassigned',
    agent_id: agent?.agent_id ?? null, name: agent?.profile?.display_name ?? agent?.profile?.name ?? null,
    task_id: route?.task?.task_id ?? null };
}

// The topic's conversations as Astro holds them: when each last moved and its
// one-line outcome. A read that fails leaves the brief with the counts alone.
async function topicConversations(application, conversationIds) {
  const wanted = new Set(conversationIds);
  try {
    const listed = await application.personal.conversation('query', { personal_space_id: application.config.personal.spaceId,
      personal_project_id: null, agent_id: ASSISTANT_AGENT_ID, source_application: null, mode: 'list',
      limit: CONVERSATION_PAGE });
    return (listed.conversations ?? []).filter(conversation => wanted.has(conversation.id))
      .map(conversation => ({ id: conversation.id, day: String(conversation.last_activity ?? '').slice(0, 10),
        outcome: singleLine(conversation.summary ?? '').slice(0, OUTCOME_CHARS) }))
      .sort((left, right) => right.day.localeCompare(left.day));
  } catch { return []; }
}

function handoffBrief(topic, conversations, conversationCount, knowledgeMoved) {
  const shown = conversations.slice(0, BRIEF_CONVERSATIONS);
  const days = conversations.map(conversation => conversation.day).filter(Boolean).sort();
  const span = days.length ? `（${days[0]} 至 ${days.at(-1)}）` : '';
  const lines = shown.map(conversation => `- ${conversation.day || '日期未知'} · ${conversation.outcome || '没有记录结果'}`);
  const rest = conversationCount - shown.length;
  return [
    `Astro 的交接：话题「${topic}」已成立为项目。`,
    `此前由 Astro 接待：${conversationCount} 个会话${span}，搬入项目 ${knowledgeMoved} 条知识。`,
    ...(lines.length ? ['会话结果（新的在前）：', ...lines] : []),
    ...(rest > 0 && lines.length ? [`另有 ${rest} 个会话没有列出。`] : []),
    '接手后：先用 search_current_project_knowledge 查搬来的知识，再定下一步；Astro 不再跟进这个话题。'
  ].join('\n');
}

// For the receipt: that Astro handed the topic over, once the lead has the task.
export function teamNotice(team) {
  return team?.handoffs.some(item => item.task_id) ? '，Astro 已交接给负责人' : '';
}
