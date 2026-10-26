import { receiptText } from '../agents/identity-receipt.js';
import { choiceNumber, parseFlaMention } from './fla-mention.js';
import { flaCandidates, flaChoice, namedAtOpening, narrowedByPartial, rankCandidates, unavailableReason }
  from './fla-picker.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { nameableProjects } from './task-entry-project-mention.js';

// Continue a named FLA in this host session (rec#54). `@Jamie Ash …` or
// `#FLA Jamie Ash …` names one of the person's FLAs in any of their projects;
// the entry then runs as that FLA in its own project, whatever folder the
// session is in, like a project the person names. A bare `@FLA`, a partial
// name or a name several FLAs share offers the native choice instead
// (fla-picker.js); its number answers it. The binding holds for the
// session's later turns until another FLA is named or `@FLA 结束` ends it.
//
// The binding is routing state, stored like a standing assignment's route:
// markers on the session's current task (withRouteMarkers), read back on the
// next entry. Nothing here authorizes: the Provider still selects the FLA
// (an explicit Agent, so a member is held by its lead as requested_agent_id),
// checks its client list and project, and decides what its reader may see.
// A target that cannot continue is said with its reason; no other FLA, the
// folder's included, is ever put in its place.

const BINDING = /^fla_binding:(\S+) (\S+) (\S+) (\S+)(?: (.+))?$/su;
const CHOICE = /^fla_choice:(\S+) (\S+) (\S+) (\S+)$/u;
const NONE = '-';
const MARKER_LIMIT = 2048;
// Markers travel with the entry under a symbol: JSON never serializes it, so
// no client receives them; beginTaskFromPreferences stores them on the task.
export const FLA_ROUTE = Symbol('fla_route');

const CONTINUE_GUIDANCE = 'The person named this FLA to continue its own work in this session; this outranks the '
  + 'folder. Work as it with the restored memory. If conversation.recent_conversation is present, resume it with '
  + 'resume_agent_conversation before acting; otherwise find its conversation with list_agent_conversations. If the '
  + 'task to continue is unclear, ask. Later turns stay with this FLA until the person names another or says @FLA 结束.';
const UNAVAILABLE_GUIDANCE = 'Tell the person this notice and do no task work: do not act as, or claim the context '
  + 'of, another FLA. They can name another FLA, pick one with @FLA, or end the binding with @FLA 结束.';
const CHOOSE_GUIDANCE = 'Ask human_interaction now and do no task work as any FLA yet. When the person picks option '
  + 'N, call begin_task_context with projectPath=current directory and taskPrompt "#FLA N", then continue as the FLA '
  + 'that entry returns. Their next message being just N, or @ with more of the name, works too.';
const REASONS = Object.freeze({
  dismissed: '已被解雇', inactive: '已停用', no_project: '目前没有在任的项目',
  client_not_allowed: '不允许在当前客户端使用', not_assigned: '已不在该项目任职', not_found: '已不存在',
  access_denied: '无权访问该 FLA 或其项目', substituted: '服务没有选中它', unavailable: '暂时无法恢复'
});
const QUESTIONS = Object.freeze({
  list: '要在本会话继续哪位 FLA？', partial: '找到这些 FLA，要继续哪一位？',
  no_match: '没有找到这个名字的 FLA，要继续哪一位？', choice_unknown: '没有这个编号，要继续哪一位？'
});

// The request a prompt and the session's current task make, or null when
// neither involves a named FLA (the entry then routes as it always did).
// readSessionTask: the session's current task, read once per entry.
export async function namedFlaRequest(application, resolution, input, readSessionTask) {
  if (hostInternalActivity(application, input)) return null;
  const mention = parseFlaMention(input.taskPrompt);
  let stored = { binding: null, choices: [] };
  try { stored = storedFla(await readSessionTask()); } catch { /* the binding cannot be proven; route as before */ }
  const previous = stored.binding;
  if (mention?.release) return { state: 'released', previous };
  const number = mention ? mention.choice ?? null : stored.choices.length ? choiceNumber(input.taskPrompt) : null;
  const picked = number === null ? null : stored.choices[number - 1];
  if (picked) return { state: 'continue', target: picked, origin: 'picked', previous };
  if (mention || number !== null) {
    let candidates;
    try { candidates = await personCandidates(application); }
    catch { return { state: 'unavailable', reason: 'unavailable', previous }; }
    const ranked = rankCandidates(candidates, { currentProjectId: resolution.personalProjectId ?? null,
      recentAgentId: previous?.agentId ?? null });
    const request = number !== null ? choose(open(ranked, input), 'choice_unknown')
      : namedRequest(mention, ranked, resolution, input);
    if (request) return { ...request, previous };
  }
  if (!previous) return null;
  // An explicit argument of the caller for another Agent or project, or an
  // `@name` that is none of the person's FLAs (FULI's own roles keep their
  // folder-scoped match), decides this call; the binding is kept.
  if (mention || (input.projectAgentId && input.projectAgentId !== previous.agentId)
    || (resolution.basis === 'explicit_personal_project_id' && resolution.personalProjectId !== previous.projectId)) {
    return { state: 'carried', previous };
  }
  return { state: 'continue', target: previous, origin: 'session', previous };
}

// The task scope a request routes to; null leaves routing to the folder, the
// session and standing assignments (a release, a carried binding).
export function namedFlaResolution(request) {
  if (request.state === 'continue') {
    const { agentId, projectId } = request.target;
    return projectId ? { status: 'matched', basis: 'explicit_fla', personalProjectId: projectId, explicitAgentId: agentId,
      fla: request } : { status: 'global', basis: 'explicit_fla', personalProjectId: null, globalAgentId: agentId,
      explicitAgentId: agentId, fla: request };
  }
  if (request.state === 'choose') {
    return { status: 'ambiguous', basis: 'fla_choice', personalProjectId: null, reason: 'fla_choice_required', fla: request };
  }
  if (request.state === 'unavailable') {
    return { status: 'unavailable', basis: 'fla_unavailable', personalProjectId: null, reason: 'fla_unavailable', fla: request };
  }
  return null;
}

// Whether a session task belongs to a named FLA's binding: after a release
// the session does not stay in that FLA's project.
export function namedFlaTask(task) {
  return Boolean(storedFla(task).binding);
}

// What the entry says and stores for the request, once the Agent is selected:
// view (the entry's `fla` field, or null on a plain bound turn), notice (one
// receipt sentence naming the FLA and project), interaction (the picker),
// selection (replaces the selection when no FLA may work this turn) and the
// markers the task stores.
export async function namedFlaEntry(application, request, selection, sourceApplication = 'other') {
  const kept = request.previous ? [bindingMarker(request.previous)] : [];
  if (request.state === 'carried') return { view: null, notice: null, markers: kept };
  if (request.state === 'released') {
    const notice = request.previous ? `已结束本会话与 ${request.previous.name ?? 'FLA'} 的绑定，回到常规项目归属`
      : '本会话没有绑定的 FLA';
    return { view: { status: 'released', notice }, notice, markers: [] };
  }
  if (request.state === 'choose') {
    const notice = '等待选择 FLA，选定前不切换';
    return { view: { status: 'choose', reason: request.reason, ...(request.more ? { more: request.more } : {}),
      notice, guidance: CHOOSE_GUIDANCE }, interaction: request.interaction, notice,
    selection: { status: 'manual_selection', worker_started: false },
    markers: [...kept, ...request.shown.map(choiceMarker)] };
  }
  if (request.state === 'unavailable') return unavailable(request.target ?? null, request.reason, kept);
  const { target } = request;
  const agent = selection?.status === 'ready' ? selection.agent : null;
  if (agent?.agentId === target.agentId) {
    const current = { ...target, name: agent.profile.displayName || agent.profile.name || target.name };
    const notice = current.projectId ? `本会话由 ${current.name} 继续项目 ${current.project} 的工作`
      : `本会话由 ${current.name} 继续其全局工作`;
    return { view: request.origin === 'session' ? null : { status: 'continuing', notice, guidance: CONTINUE_GUIDANCE },
      notice, markers: [bindingMarker(current, notice)] };
  }
  if (agent && selection.requested_agent_id === target.agentId) {
    const lead = agent.profile.displayName || agent.profile.name || agent.agentId;
    const notice = `${target.name} 是项目 ${target.project} 的成员，本会话由负责人 ${lead} 持有并请 ${target.name} 处理`;
    return { view: { status: 'held_by_lead', notice }, notice, markers: [bindingMarker(target, notice)] };
  }
  const reason = await whyUnavailable(application, target, selection, sourceApplication);
  const result = unavailable(target, reason, []);
  return { ...result, markers: [bindingMarker(target, result.notice)] };
}

// The checkpoint receipt repeats the sentence the bound turn's entry showed.
export function namedFlaReceiptNotices(task) {
  const notice = storedFla(task).binding?.notice;
  return notice ? [receiptText(notice)] : [];
}

function unavailable(target, reason, markers) {
  const notice = target ? `${target.name}（${target.project ?? '全局'}）无法继续：${REASONS[reason] ?? REASONS.unavailable}，未改用其他 FLA`
    : reason === 'no_flas' ? '还没有可以继续的 FLA' : `无法读取你的 FLA：${REASONS[reason] ?? REASONS.unavailable}`;
  return { view: { status: 'unavailable', reason, notice, guidance: UNAVAILABLE_GUIDANCE }, notice,
    selection: { status: 'agent_unavailable', reason, worker_started: false }, markers };
}

function namedRequest(mention, ranked, resolution, input) {
  const available = open(ranked, input);
  if (!mention.query) return choose(available, 'list');
  const exact = namedAtOpening(mention.query, ranked);
  if (exact.length) {
    const named = open(exact, input);
    if (!named.length) {
      return { state: 'unavailable', target: target(exact[0]), reason: unavailableReason(exact[0], source(input)) };
    }
    const only = single(named, resolution.personalProjectId ?? null);
    return only ? { state: 'continue', target: target(only), origin: 'named' }
      : choose(named, 'same_name', `有多位「${named[0].name}」，要继续哪一位？`);
  }
  const narrowed = narrowedByPartial(mention.query, available);
  if (narrowed.length === 1) return { state: 'continue', target: target(narrowed[0]), origin: 'named' };
  if (narrowed.length) return choose(narrowed, 'partial');
  // `@word` that is no FLA's name stays an ordinary prompt; `#FLA word` asks.
  return mention.explicit ? choose(available, 'no_match') : null;
}

// One FLA in several projects, one of them this folder's, continues there.
// Different FLAs sharing a name are always asked.
function single(named, currentProjectId) {
  if (named.length === 1) return named[0];
  const here = named.filter(item => item.projectId === currentProjectId);
  return here.length === 1 && named.every(item => item.agentId === named[0].agentId) ? here[0] : null;
}

function choose(candidates, reason, question = QUESTIONS[reason]) {
  if (!candidates.length) return { state: 'unavailable', reason: 'no_flas' };
  const { shown, more, interaction } = flaChoice(candidates, { title: '选择 FLA', question });
  return { state: 'choose', reason, shown: shown.map(target), more, interaction };
}

function open(candidates, input) {
  return candidates.filter(item => !unavailableReason(item, source(input)));
}

function source(input) {
  return input.sourceApplication ?? 'other';
}

function target(candidate) {
  return { agentId: candidate.agentId, projectId: candidate.projectId ?? null, name: candidate.name,
    project: candidate.project };
}

async function personCandidates(application) {
  const spaceId = application.config.personal.spaceId;
  const [roster, projects] = await Promise.all([application.personal.listProjectAgents(spaceId, null),
    nameableProjects(application)]);
  const agents = Array.isArray(roster) ? roster : roster?.agents ?? roster?.items ?? [];
  return flaCandidates(agents, projects, spaceId);
}

// Read only when the FLA could not continue: its own record says why.
async function whyUnavailable(application, target, selection, sourceApplication) {
  if (selection?.status === 'ready') return 'substituted';
  try {
    const record = await application.personal.getProjectAgent(application.config.personal.spaceId,
      target.projectId, target.agentId);
    return unavailableReason({ status: record.profile?.status ?? 'active', projectId: target.projectId,
      clients: record.profile?.allowed_clients ?? [] }, sourceApplication) ?? 'unavailable';
  } catch (error) {
    if (error?.status === 403) return 'access_denied';
    if (error?.status === 404) return target.projectId ? 'not_assigned' : 'not_found';
    return 'unavailable';
  }
}

// Marker fields: IDs and names with spaces and % escaped, `-` for none.
const field = value => value === null || value === undefined ? NONE
  : String(value).replace(/%/g, '%25').replace(/\s/g, '%20');
const unfield = value => {
  if (value === NONE) return null;
  try { return decodeURIComponent(value); } catch { return null; }
};

function bindingMarker(target, notice = null) {
  const marker = `fla_binding:${field(target.agentId)} ${field(target.projectId)} ${field(target.name)} ${field(target.project)}`;
  return notice ? [...`${marker} ${notice}`].slice(0, MARKER_LIMIT).join('') : marker;
}

function choiceMarker(target) {
  return `fla_choice:${field(target.agentId)} ${field(target.projectId)} ${field(target.name)} ${field(target.project)}`;
}

function storedFla(task) {
  const basis = task?.agentAssignment?.match_basis ?? [];
  const parsed = pattern => basis.map(item => pattern.exec(item)).filter(Boolean)
    .map(([, agentId, projectId, name, project, notice]) => ({ agentId: unfield(agentId), projectId: unfield(projectId),
      name: unfield(name), project: unfield(project), ...(notice ? { notice } : {}) }))
    .filter(item => item.agentId);
  return { binding: parsed(BINDING)[0] ?? null, choices: parsed(CHOICE) };
}
