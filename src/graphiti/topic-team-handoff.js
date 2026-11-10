import { ASSISTANT_AGENT_ID } from './assistant-identity.js';
import { singleLine } from '../text/single-line.js';

// When a topic grows into a project (topic-proposals.js), Astro has Bole hire
// a small team for it and hands the work over to each of them (Jevons 11-11).
// Bole has no runtime of its own: hiring is the Provider's ordinary staffing
// task, one per position. Each person's handover is a task of their own,
// assigned and not started: the lead's carries the whole brief, a member's
// says what they are there for. The brief is an index (dates and one-line
// outcomes of the topic's conversations, how much knowledge moved); bodies
// stay where they are and are read on demand. Nothing here calls a model, and
// nothing here can undo the formation: a step that fails is reported.

// The lead's own first rule ("执行与独立验收两位 FLA") decides who is hired
// until the topic's own work kinds are read.
const TEAM_POSITIONS = Object.freeze([
  { key: 'engineering', workKind: 'implementation', label: '开发',
    duty: '按负责人的拆分实现和修复，改动附可复现的验证。' },
  { key: 'verification', workKind: 'verification', label: '独立验收',
    duty: '独立验收别人的实质性改动：自己复现、自己判断，不沿用实现者的结论。' }
]);
const BRIEF_CONVERSATIONS = 8;
const OUTCOME_CHARS = 120;
const TOPIC_CHARS = 60;
const CONVERSATION_PAGE = 50;

// topic, projectId and lead come from the formation; conversationIds and
// knowledgeMoved from what it attached. Returns who was hired and what each
// was handed, for the notice and the console.
export async function staffTopicTeam(application, { topic, projectId, lead, created, conversationIds, knowledgeMoved,
  sourceApplication = 'other' }) {
  const spaceId = application.config.personal.spaceId;
  const name = topic.slice(0, TOPIC_CHARS);
  const conversations = await topicConversations(application, conversationIds);
  const brief = handoffBrief(name, conversations, conversationIds.length, knowledgeMoved);
  const submit = async (position, body) => {
    try {
      return handed(position, await application.personal.submitProjectAgentTask({
        personal_space_id: spaceId, personal_project_id: projectId, duration: 'ongoing', start: false,
        source_application: sourceApplication, idempotency_key: `topic-handoff:${projectId}:${position}`, ...body }));
    } catch { return { position, status: 'unavailable', agent_id: null, name: null, task_id: null }; }
  };

  const handoffs = [await submit('lead', { lead_agent_id: lead.agent_id, staffing_intent: 'reuse_preferred',
    work_kind: 'project_context', title: `接手「${name}」`, objective: brief,
    routing_reason: 'Astro hands the topic it looked after over to the project lead.' })];
  // A project that already had people keeps its team: only the lead is briefed.
  if (created && await withoutApproval(application, spaceId, projectId)) {
    for (const position of TEAM_POSITIONS) {
      handoffs.push({ ...await submit(position.key, { staffing_intent: 'new_durable', work_kind: position.workKind,
        coordinator_agent_id: lead.agent_id, title: `接手「${name}」：${position.label}`,
        objective: `${position.duty}\n负责人：${lead.profile?.display_name ?? lead.profile?.name ?? lead.agent_id}。\n\n${brief}`.slice(0, 4096),
        routing_reason: 'Astro asked Bole for the team of a topic that grew into a project.',
        recruitment_profile: { name: `${name} ${position.label}`, responsibility: position.duty,
          work_kinds: [position.workKind], agent_type: 'durable' } }), label: position.label });
    }
  }
  return { handoffs, conversations: conversationIds.length, knowledge: knowledgeMoved };
}

// A project Astro just formed hires its first team without a confirmation
// each (rec#11 D-84); the person can turn asking back on in the project's
// settings. False when the policy could not be saved: nobody is hired then.
async function withoutApproval(application, spaceId, projectId) {
  try {
    await application.personal.updateProjectAgentCoordinationPolicy({ personal_space_id: spaceId,
      personal_project_id: projectId, ask_before_recruitment: false });
    return true;
  } catch { return false; }
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

export function handoffBrief(topic, conversations, conversationCount, knowledgeMoved) {
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

// One sentence for the receipt: who Bole hired and what Astro handed over.
export function teamNotice(team) {
  if (!team) return '';
  const hired = team.handoffs.filter(item => item.agent_id && item.position !== 'lead');
  const people = hired.map(item => `${item.label} ${item.name ?? item.agent_id}`).join('、');
  const handed = team.handoffs.filter(item => item.task_id).length;
  return `${hired.length ? `，Bole 招了 ${hired.length} 人（${people}）` : ''}`
    + `${handed ? `，Astro 已交接给 ${handed} 人` : ''}`;
}
