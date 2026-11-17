import { receiptSummary, receiptText } from '../agents/identity-receipt.js';
import { sha256Bytes } from '../security/digest.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { TASK_ENTRY_TOOLS } from './repository-project-registration.js';

// A new FLA introduces itself once, in the receipt line under its name
// (11-17): the first time it owns one of the person's tasks, when it was
// created after introductions began (FLAs the person already had are known).
// A project whose tasks pass from one FLA to another says so once too (a
// hand-off, naming both). Only the owner of a person's own task entry does;
// a worker run, a roundtable wake and a tool that only reads preferences do
// not. What was said is kept locally (agent-introductions store); the line
// rides on the task as a route marker, so a receipt that replaces the
// entry's (checkpoint, roundtable, pause, recovery) carries it the same turn,
// and so does a second entry of the same turn.

const MARKER = /^fla_introduction (.+)$/su;
// Code points each value may take in the line; with the longest template the
// line stays within 100 characters (test/fla-introduction.test.js measures it).
const LIMITS = Object.freeze({ name: 14, project: 14, previous: 14, duty: 16 });
// The first clause of a profile's responsibility is what the line calls its duty.
const CLAUSE_END = /[，,。；;：:\n]|\.\s/u;
// A project changes owner only when its own routing chose the project's lead;
// a member picked for the work kind works there without taking it over.
const LEAD_REASONS = new Set(['project_team_lead']);

const duty = value => value ? `（${value}）` : '';
// Projectless tasks (an unclaimed conversation's Astro) are "things not in a project yet".
const area = project => project ? ` ${project} 的事` : '还没归项目的事';

// Same FLA, same wording: the variant is chosen by its agent ID. A hand-off
// promises only the project's work: the earlier FLA's own memory stays its own.
const FIRST_MEETING = [
  v => `👋 初次见面，我是 ${v.name}${duty(v.duty)}。以后${area(v.project)}找我，消息开头写 ${v.address}。`,
  v => `🌱 新助手 ${v.name} 报到${duty(v.duty)}！以后${area(v.project)}归我照看，有事消息开头写 ${v.address}。`,
  v => `🎒 ${v.name} 到岗${duty(v.duty)}，以后${area(v.project)}交给我。找我的暗号：消息开头写 ${v.address}。`,
  v => `☕ 你好，我是 ${v.name}${duty(v.duty)}，以后${area(v.project)}归我管。想找我，消息开头写 ${v.address}。`
];
const HANDOFF = [
  v => `🤝 ${v.project} 从 ${v.previous} 手里交到我 ${v.name} 这儿了：项目里的事我接着办，找我消息开头写 ${v.address}。`,
  v => `🏃 接力棒到手！${v.project} 由 ${v.previous} 交给我 ${v.name}，项目里的事我接着办，找我消息开头写 ${v.address}。`,
  v => `🔑 ${v.previous} 把 ${v.project} 的钥匙交给了我 ${v.name}，项目里的事我接着办；找我消息开头写 ${v.address}。`,
  v => `📦 ${v.name} 从 ${v.previous} 那儿接过 ${v.project} 啦，项目里的事我接着办；找我消息开头写 ${v.address}。`
];

// The entry's introduction ({ line, marker }), or null. A second entry of the
// same turn for the same owner repeats the first one's (resolution.turnIntroduction)
// without asking the store, which already counts it as said. A project's owner
// is tracked only when routing chose the project's lead: an FLA the person or
// host named (#FLA, #FLG, an explicit Agent) or a member picked for the work
// works there without taking it over. sessionOwnerFrom is the FLA a session
// owner-change notice already names as the earlier one: a hand-off from it
// would say the same twice, so it is left out.
export function introductionEntry(application, { resolution, selection, context, input, sessionOwnerFrom = null,
  now = new Date() }) {
  const agentId = selection?.agent?.agentId;
  if (!agentId || !context?.role || !application.agentIntroductions || !input.agentInvocation
    || !TASK_ENTRY_TOOLS.has(input.agentToolName)
    || hostInternalActivity(application, { sessionId: input.sessionId ?? input.sourceSessionId ?? null })) return null;
  const carried = resolution.turnIntroduction;
  if (carried?.agentId === agentId) return entryOf(carried.line);
  const projectId = resolution.personalProjectId ?? null;
  const led = LEAD_REASONS.has(selection.reason) || context.team?.lead_agent_id === agentId;
  const routed = projectId && led && !resolution.fla && !resolution.group && !input.projectAgentId;
  let met;
  try {
    met = application.agentIntroductions.meet({ personalSpaceId: application.config.personal.spaceId, agentId,
      agentCreatedAt: selection.agent.createdAt ?? null, agentName: context.role.name ?? null,
      projectId: routed ? projectId : null, at: now.toISOString() });
  } catch {
    // A store this FULI cannot use introduces nobody; the entry goes on.
    return null;
  }
  const previous = met.previousOwner?.agentId === sessionOwnerFrom ? null : met.previousOwner;
  const line = introductionLine({ agentId, name: context.role.name ?? agentId,
    responsibility: context.role.responsibility, project: projectId ? context.project_brief?.name || '这个项目' : null,
    previous: previous ? previous.name ?? previous.agentId : null, firstMeeting: met.firstMeeting });
  return line ? entryOf(line) : null;
}

// The introduction the session's current task gave, when this entry is a
// second one of the same turn: the client's prompt hook run again with the
// same turn ID (Codex, for input arriving mid-turn), or the Agent's own
// get_collaboration_preferences while that task has no completed checkpoint.
export function sameTurnIntroduction(sessionTask, { turnId = null, agentToolName = null } = {}) {
  if (!sessionTask?.projectAgentId || sessionTask.checkpoint?.phase === 'complete') return null;
  const sameTurn = turnId ? sessionTask.turnId === turnId : agentToolName === 'get_collaboration_preferences';
  const line = sameTurn ? introductionReceiptLine(sessionTask) : null;
  return line ? { agentId: sessionTask.projectAgentId, line } : null;
}

// The receipt line a task's entry introduced its owner with, or null.
export function introductionReceiptLine(task) {
  return (task?.agentAssignment?.match_basis ?? []).map(item => MARKER.exec(item)).find(Boolean)?.[1] ?? null;
}

function entryOf(line) {
  return { line, marker: `fla_introduction ${line}` };
}

// One Markdown line of receipt text, every value escaped. A name too long to
// show whole is addressed by a bare #FLA, which lists the person's FLAs.
function introductionLine({ agentId, name, responsibility, project, previous, firstMeeting }) {
  const templates = previous ? HANDOFF : firstMeeting ? FIRST_MEETING : null;
  if (!templates) return null;
  const shown = name.replace(/\s+/g, ' ').trim();
  return templates[parseInt(sha256Bytes(agentId).slice(0, 8), 16) % templates.length]({
    name: receiptSummary(shown, LIMITS.name),
    address: [...shown].length <= LIMITS.name ? `#FLA ${receiptText(shown)}` : '#FLA',
    duty: firstClause(responsibility), project: project && receiptSummary(project, LIMITS.project),
    previous: previous && receiptSummary(previous, LIMITS.previous) });
}

function firstClause(responsibility) {
  const clause = String(responsibility ?? '').trim().split(CLAUSE_END)[0].trim();
  return clause ? receiptSummary(clause, LIMITS.duty) : null;
}
