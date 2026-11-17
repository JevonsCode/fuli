import { receiptSummary, receiptText } from '../agents/identity-receipt.js';
import { sha256Bytes } from '../security/digest.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { TASK_ENTRY_TOOLS } from './repository-project-registration.js';

// An FLA introduces itself once, in the receipt line under its name (11-17):
// the first time it owns one of the person's tasks, and when a project's
// tasks pass to it from another FLA (a hand-off, which names both). Only the
// owner of a person's own task entry does; a worker run, a roundtable wake
// and a tool that only reads preferences do not. Whether it was said is kept
// locally (agent-introductions store); the line rides on the task as a route
// marker, so a receipt that replaces the entry's (checkpoint, roundtable,
// pause, recovery) carries it the same turn.

const MARKER = /^fla_introduction (.+)$/su;
// Code points each value may take in the line; with the longest template the
// line stays within LINE_LIMIT (test/fla-introduction.test.js measures it).
const LIMITS = Object.freeze({ name: 14, project: 14, previous: 14, duty: 16 });
// The first clause of a profile's responsibility is what the line calls its duty.
const CLAUSE_END = /[，,。；;：:\n]|\.\s/u;

const duty = value => value ? `（${value}）` : '';
// Projectless tasks (an unclaimed conversation's Astro) are "things not in a project yet".
const area = project => project ? ` ${project} 的事` : '还没归项目的事';

// Same FLA, same wording: the variant is chosen by its agent ID.
const FIRST_MEETING = [
  v => `👋 初次见面，我是 ${v.name}${duty(v.duty)}。以后${area(v.project)}找我，消息开头写 ${v.address}。`,
  v => `🌱 新助手 ${v.name} 报到${duty(v.duty)}！以后${area(v.project)}归我照看，有事消息开头写 ${v.address}。`,
  v => `🎒 ${v.name} 到岗${duty(v.duty)}，以后${area(v.project)}交给我。找我的暗号：消息开头写 ${v.address}。`,
  v => `☕ 你好，我是 ${v.name}${duty(v.duty)}，以后${area(v.project)}归我管。想找我，消息开头写 ${v.address}。`
];
const HANDOFF = [
  v => `🤝 ${v.project} 从 ${v.previous} 手里交到我 ${v.name} 这儿了：之前的事我都接着，找我消息开头写 ${v.address}。`,
  v => `🏃 接力棒到手！${v.project} 由 ${v.previous} 交给我 ${v.name}，往后的事找我，消息开头写 ${v.address}。`,
  v => `🔑 ${v.previous} 把 ${v.project} 的钥匙交给了我 ${v.name}，进度我都接着；找我消息开头写 ${v.address}。`,
  v => `📦 ${v.project} 换我 ${v.name} 接手啦，${v.previous} 留下的事我都接着；找我消息开头写 ${v.address}。`
];

// The entry's introduction ({ line, marker }), or null. A project's owner is
// tracked only when the project's own routing chose it: an FLA the person or
// host named (#FLA, #FLG, an explicit Agent) works there without taking it over.
export function introductionEntry(application, { resolution, selection, context, input, now = new Date() }) {
  const agentId = selection?.agent?.agentId;
  if (!agentId || !context?.role || !application.agentIntroductions || !input.agentInvocation
    || !TASK_ENTRY_TOOLS.has(input.agentToolName)
    || hostInternalActivity(application, { sessionId: input.sessionId ?? input.sourceSessionId ?? null })) return null;
  const projectId = resolution.personalProjectId ?? null;
  const routed = projectId && !resolution.fla && !resolution.group && !input.projectAgentId;
  let met;
  try {
    met = application.agentIntroductions.meet({ personalSpaceId: application.config.personal.spaceId, agentId,
      agentName: context.role.name ?? null, projectId: routed ? projectId : null, at: now.toISOString() });
  } catch {
    // A store this FULI cannot use introduces nobody; the entry goes on.
    return null;
  }
  const line = introductionLine({ agentId, name: context.role.name ?? agentId,
    responsibility: context.role.responsibility, project: projectId ? context.project_brief?.name || '这个项目' : null,
    previous: met.previousOwner ? met.previousOwner.name ?? met.previousOwner.agentId : null,
    firstMeeting: met.firstMeeting });
  return line ? { line, marker: `fla_introduction ${line}` } : null;
}

// The receipt line a task's entry introduced its owner with, or null.
export function introductionReceiptLine(task) {
  return (task?.agentAssignment?.match_basis ?? []).map(item => MARKER.exec(item)).find(Boolean)?.[1] ?? null;
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
