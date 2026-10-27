import { randomUUID } from 'node:crypto';
import { groupChoiceReply, parseFlaMention } from './fla-mention.js';
import { flaGroupChoice, namedInText, rankCandidates, unavailableReason } from './fla-picker.js';
import { personCandidates } from './task-entry-named-fla.js';
import { recommendMembers } from './group-member-recommendation.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { markerField as field, markerValue as unfield } from './task-agent-assignment.js';
import { WAKE_CLIENTS } from '../../packages/roundtable/src/agents/wake-registry.js';

// `@FLG …` (Fuli Agents Group, rec#55): the person invites several of their
// FLAs to discuss a question in this chat. The entry only prepares it:
//
// 1. `@FLG <question>` offers a multi-select of 2–4 members (fla-picker.js):
//    the FLAs the text names, preselected and never replaced (one name several
//    FLAs share is offered as each of them, unchecked); when it names none,
//    or asks for more, the FLAs that fit the question
//    (group-member-recommendation.js), each with a short reason.
// 2. The person confirms: numbers such as `1 3`, or `@FLG 开始` for the
//    preselection (the host's native answer comes back as `@FLG 1 3`). The
//    entry records the confirmed members and question in the roundtable and
//    hands its request ID to the session's own Agent, which moderates with the
//    group_discussion tool; start runs exactly that confirmation, once
//    (packages/roundtable/src/roundtable/group-discussion.js).
// 3. While that discussion is open, `@FLG <text>` records the person's
//    follow-up for the same members (one follow_up each) and `@FLG 结束`
//    stops it at once. No extra step is asked of the person.
//
// The member choice and the started discussion are routing state, stored as
// markers on the session's current task like a named FLA's choice; the
// marker is dropped once the discussion ends. Nothing here wakes or reads
// memory; the moderator needs a project task because the roundtable only lets
// a project task's Agent open a group chat.

const CHOICE = /^flg_choice:(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) ([01])$/u;
const QUESTION = /^flg_question:(.*)$/su;
const STARTED = /^flg_group:(\S+)$/u;
const MEMBER_MINIMUM = 2;
const OPTION_LIMIT = 4;
const RECOMMENDED = 3;
const QUESTION_LIMIT = 1500;
const MORE = /推荐|再找|再加|再请|再邀|补充|还要|recommend|suggest|more/iu;
const COUNT = /([1-4一二两三四])\s*(?:位|个|名)/u;
const NUMBERS = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 });
// Words that sound like a yes but are not the choice's confirmation (`@FLG 开始`).
const LOOSE_YES = /^(?:好|好的|好吧|行|可以|嗯|对|是|ok|okay|yes|yep|sure)\s*[。.!！~～]?\s*$/iu;
// A discussion in progress keeps its session where it is.
const ACTIVE = new Set(['confirmed', 'running']);

const CHOOSE_GUIDANCE = 'Ask this now with the host native multi-select UI, the preselected options checked and '
  + 'custom input last; where there is none, show the numbered list and let the person reply with numbers such as '
  + '"1 3", or "@FLG 开始" for the checked ones. Start nothing and speak for no member before the answer. When they '
  + 'answer, call begin_task_context with projectPath=current directory and taskPrompt "@FLG <the chosen numbers>" '
  + '(or "@FLG 开始") and follow its flg.guidance. A choice is not a permission grant.';
const START_GUIDANCE = 'The person confirmed these members. Call group_discussion with action start, this entry\'s '
  + 'taskContextToken and start.requestId. Each member is woken in its own client without file edits or shell and answers for itself: '
  + 'never write or guess a member\'s view. Then call group_discussion wait and follow its guidance until it '
  + 'concludes. The discussion authorizes no edits or publishing.';
const FOLLOW_UP_GUIDANCE = 'The person asked this follow-up of the same members; do not choose members again. Call '
  + 'group_discussion follow_up with chat_id (it carries out exactly this follow-up), then wait and follow its guidance.';
const STOPPED_GUIDANCE = 'The person stopped this discussion; no member is woken any more. Call group_discussion '
  + 'status with chat_id and follow its guidance for the summary.';
const REASONS = Object.freeze({
  dismissed: '已被解雇', inactive: '已停用', no_project: '目前没有在任的项目', no_executor: '没有可唤醒它的执行器',
  moderator: '是本会话的主持，不另外唤醒'
});
const NOTICES = Object.freeze({
  project_required: '@FLG 需要由项目里的 FLA 主持；当前会话不在项目中，没有发起讨论',
  roster_unavailable: '暂时读不到你的 FLA，没有发起讨论',
  too_many: `一次最多邀请 ${OPTION_LIMIT} 位 FLA，请少点几位`,
  not_enough: '能参加讨论的 FLA 不足两位，没有发起讨论',
  no_choice: '没有待确认的 @FLG 成员列表；用「@FLG 问题」发起讨论',
  none_running: '本会话没有进行中的 @FLG 讨论',
  stop_unavailable: '暂时无法停止 @FLG 讨论，请稍后再说一次 @FLG 结束',
  roundtable_unavailable: '暂时无法记录确认的成员，没有发起讨论',
  not_started: '这场 @FLG 讨论还没开始，开始后再追问',
  follow_up_limit: '这场 @FLG 讨论已追问 5 次，到了上限；再写「@FLG 问题」会重新选人',
  question_required: '请在 @FLG 后写上要讨论的问题，例如「@FLG 讨论这个方案的产品体验和技术风险」'
});

// What a prompt and the session's current task ask of a group discussion, or
// null. task: the session's current task (its markers), read once per entry.
// holdsProject: this turn stays where the session is (no standing-assignment
// reroute) — an `@FLG` turn, or any turn while its discussion is in progress.
export function groupDiscussionRequest(application, input, task) {
  const mention = parseFlaMention(input.taskPrompt)?.group ?? null;
  const stored = storedGroup(task);
  // A discussion that ended, or that this FULI cannot find, is no longer carried.
  const status = stored.started ? discussionStatus(application, stored.started) : null;
  if (!status || status.status === 'ended') stored.started = null;
  const carried = stored.started ? { state: 'carried', stored, holdsProject: ACTIVE.has(status.status) } : null;
  if (hostInternalActivity(application, input)) return carried;
  const reply = mention && (mention.choices || mention.confirm) ? mention
    : !mention && stored.choices.length ? groupChoiceReply(input.taskPrompt) : null;
  if (reply) return { state: stored.choices.length ? 'confirm' : 'no_choice', reply, stored, holdsProject: true };
  // `@FLG 好` / `@FLG ok` while a choice waits is an unclear answer to it, not a new question.
  if (mention?.query && stored.choices.length && LOOSE_YES.test(mention.query)) {
    return { state: 'unclear', stored, holdsProject: true };
  }
  if (!mention) return carried;
  if (mention.release) return { state: 'stop', stored, holdsProject: true };
  return { state: 'ask', query: mention.query, stored, status, holdsProject: true };
}

// What the entry says, offers and stores, once the session's own Agent (the
// moderator) is selected: view (the entry's `flg` field), interaction (the
// member choice), notice (one receipt sentence), selection (replaces the
// selection when no Agent works this turn) and markers.
export async function groupDiscussionEntry(application, request, selection, personalProjectId) {
  const kept = request.stored.started ? [startedMarker(request.stored.started)] : [];
  if (request.state === 'carried') return { markers: kept };
  if (request.state === 'no_choice') return said('unavailable', 'no_choice', kept);
  if (request.state === 'stop') {
    let stopped = null;
    try {
      stopped = request.stored.started
        ? await application.roundtable?.ownerStopGroupDiscussion?.({ requestId: request.stored.started }) : null;
    } catch { return said('unavailable', 'stop_unavailable', kept); }
    if (!stopped) return said('unavailable', 'none_running', []);
    const notice = '已停止 @FLG 讨论，未回复的成员不计入结论';
    return { view: { status: 'stopped', chat_id: stopped.chatId, notice, guidance: STOPPED_GUIDANCE }, notice,
      selection: noAgent(), markers: kept };
  }
  const moderator = selection?.status === 'ready' && personalProjectId ? selection.agent?.agentId ?? null : null;
  if (!moderator) return said('unavailable', 'project_required', kept);
  if (request.state === 'confirm') return confirmed(application, request, moderator, personalProjectId);
  if (request.state === 'unclear') return chooseAgain(request.stored, '请回复编号，或用「@FLG 开始」确认已勾选的');
  if (!request.query) return said('unavailable', 'question_required', kept);
  if (request.status?.followUps >= request.status?.maxFollowUps) return said('unavailable', 'follow_up_limit', []);
  const current = request.stored.started ? await startedDiscussion(application, request.stored.started) : null;
  if (current) return followUp(application, current, request.query, kept);
  return memberChoice(application, request.query, { moderator, personalProjectId });
}

async function memberChoice(application, query, { moderator, personalProjectId }) {
  let candidates;
  try { candidates = await personCandidates(application); } catch { return said('unavailable', 'roster_unavailable', []); }
  const ranked = rankCandidates(candidates, { currentProjectId: personalProjectId });
  const notices = [];
  const options = [];
  for (const items of namedInText(query, ranked)) {
    const open = items.filter(item => !memberUnavailable(item, moderator));
    if (!open.length) {
      notices.push(`${items[0].name} 无法参加：${REASONS[memberUnavailable(items[0], moderator)]}，未改用其他 FLA`);
      continue;
    }
    const agents = [...new Set(open.map(item => item.agentId))];
    // One FLA in several projects is offered once, in this project when it works here.
    if (agents.length === 1) options.push({ ...(open.find(item => item.projectId === personalProjectId) ?? open[0]),
      preselected: true, note: '点名' });
    else options.push(...agents.map(id => ({ ...open.find(item => item.agentId === id), preselected: false,
      note: '同名，请选择' })));
  }
  if (options.length > OPTION_LIMIT) return said('unavailable', 'too_many', []);
  const named = options.length;
  const wantsMore = MORE.test(query);
  const typed = COUNT.exec(query)?.[1];
  const count = typed ? NUMBERS[typed] ?? Number(typed) : null;
  const room = OPTION_LIMIT - options.length;
  const wanted = Math.min(room, !named ? count ?? RECOMMENDED : wantsMore ? count ?? 1 : room);
  const taken = new Set([moderator, ...options.map(item => item.agentId)]);
  const pool = ranked.filter((item, index) => !taken.has(item.agentId) && !memberUnavailable(item, moderator)
    && ranked.findIndex(other => other.agentId === item.agentId) === index);
  const recommended = recommendMembers(query, pool, { count: wanted, currentProjectId: personalProjectId,
    standing: standingMatches(application, query) });
  options.push(...recommended.map(item => ({ ...item, preselected: !named || wantsMore })));
  if (options.length < MEMBER_MINIMUM) return said('unavailable', 'not_enough', [], notices);
  const question = !named ? '按问题推荐了这些 FLA，要邀请哪几位一起讨论？'
    : options.some(item => item.note === '同名，请选择') ? '有同名的 FLA，请选出要邀请的那一位，再确认成员'
      : wantsMore ? '你点名的和推荐的 FLA 已勾选，要邀请哪几位？' : '你点名的 FLA 已勾选，还要加谁吗？';
  const { shown, interaction } = flaGroupChoice(options, { title: '选择 @FLG 讨论成员', question, guidance: CHOOSE_GUIDANCE });
  const notice = ['等待确认 @FLG 讨论成员', ...notices].join('；');
  const text = [...query].slice(0, QUESTION_LIMIT).join('');
  return { view: { status: 'choose', question: text, notice }, interaction, notice,
    selection: noAgent(), markers: [`flg_question:${text}`, ...shown.map(choiceMarker)] };
}

// The same member choice again, saying why the last answer did not confirm it.
function chooseAgain({ choices, question }, reason) {
  const { interaction } = flaGroupChoice(choices, { title: '选择 @FLG 讨论成员',
    question: `${reason}，要邀请哪几位一起讨论？`, guidance: CHOOSE_GUIDANCE });
  const notice = `等待确认 @FLG 讨论成员：${reason}`;
  return { view: { status: 'choose', question, notice }, interaction, notice,
    selection: noAgent(), markers: [`flg_question:${question}`, ...choices.map(choiceMarker)] };
}

function confirmed(application, request, moderator, personalProjectId) {
  const { choices, question } = request.stored;
  const picked = request.reply.confirm ? choices.filter(item => item.preselected)
    : request.reply.choices.map(number => choices[number - 1]);
  const unknown = request.reply.choices?.filter(number => !choices[number - 1]) ?? [];
  // The session's own Agent moderates; it is said, never silently dropped.
  const moderating = picked.find(item => item?.agentId === moderator);
  const members = [...new Map(picked.filter(Boolean).filter(item => item.agentId !== moderator)
    .map(item => [item.agentId, item])).values()];
  if (unknown.length || members.length < MEMBER_MINIMUM) {
    return chooseAgain(request.stored, [unknown.length ? `没有编号 ${unknown.join('、')}` : '至少选两位',
      ...(moderating ? [`${moderating.name} ${REASONS.moderator}`] : [])].join('；'));
  }
  const requestId = `flg-${randomUUID()}`;
  // What the person confirmed is recorded where start checks it.
  try {
    if (!application.roundtable?.recordGroupChoice) throw new Error('No roundtable');
    application.roundtable.recordGroupChoice({ requestId, agentId: moderator, projectId: personalProjectId,
      question, members: members.map(item => item.agentId) });
  } catch { return said('unavailable', 'roundtable_unavailable', []); }
  const notice = [`已确认 ${members.length} 位 @FLG 讨论成员：${members.map(item => item.name).join('、')}`,
    ...(moderating ? [`${moderating.name} ${REASONS.moderator}`] : [])].join('；');
  return { view: { status: 'confirmed', notice, start: { requestId }, guidance: START_GUIDANCE }, notice,
    markers: [startedMarker(requestId)] };
}

// The person's `@FLG <text>` for the discussion this session started: recorded
// as the follow-up the moderator may carry out once, to everyone or to the
// one member it names.
function followUp(application, current, text, kept) {
  if (!current.chatId) return said('unavailable', 'not_started', kept);
  const named = namedInText(text, current.members.map(member => ({ agentId: member.agentId,
    name: member.name.replace(/（.*）$/u, '') })));
  const to = named.length === 1 && named[0].length === 1 ? named[0][0].agentId : null;
  let recorded;
  try { recorded = application.roundtable.requestGroupFollowUp({ requestId: current.requestId, body: text, to }); }
  catch { return said('unavailable', 'roundtable_unavailable', kept); }
  if (recorded.refused === 'limit') return said('unavailable', 'follow_up_limit', []);
  if (!recorded.recorded) return said('unavailable', 'none_running', []);
  const notice = to ? `追问 @FLG 讨论中的 ${named[0][0].name}` : '在同一个 @FLG 讨论里追问全部成员';
  return { view: { status: 'follow_up', chat_id: current.chatId, discussion_status: current.status,
    ...(to ? { to } : {}), notice, guidance: FOLLOW_UP_GUIDANCE }, notice, markers: kept };
}

// The started discussion's status ({ status, followUps, maxFollowUps }), or
// null when there is none or it cannot be read.
function discussionStatus(application, requestId) {
  try { return application.roundtable?.groupDiscussionStatus?.({ requestId }) ?? null; } catch { return null; }
}

// Why an FLA cannot take part, or null: dismissed or inactive, no project, no
// client a roundtable wake can start, or this session's own Agent.
function memberUnavailable(item, moderator) {
  if (item.agentId === moderator) return 'moderator';
  const reasons = WAKE_CLIENTS.map(client => unavailableReason(item, client));
  if (reasons.includes(null)) return null;
  return reasons.find(reason => reason !== 'client_not_allowed') ?? 'no_executor';
}

// The discussion this session started, or null when there is none or it
// cannot be read (a new `@FLG` then starts another).
async function startedDiscussion(application, requestId) {
  if (!requestId || !application.roundtable?.ownerGroupDiscussion) return null;
  try { return await application.roundtable.ownerGroupDiscussion({ requestId }); } catch { return null; }
}

function standingMatches(application, query) {
  try { return application.standingAssignments?.match(application.config.personal.spaceId, query) ?? []; }
  catch { return []; }
}

function said(status, reason, markers, extra = []) {
  const notice = [NOTICES[reason], ...extra].join('；');
  return { view: { status, reason, notice }, notice, selection: noAgent(), markers };
}

function noAgent() {
  return { status: 'manual_selection', worker_started: false };
}

function choiceMarker(item) {
  return `flg_choice:${[item.agentId, item.projectId, item.name, item.project, item.occupation, item.note]
    .map(field).join(' ')} ${item.preselected ? 1 : 0}`;
}

function startedMarker(requestId) {
  return `flg_group:${requestId}`;
}

function storedGroup(task) {
  const basis = task?.agentAssignment?.match_basis ?? [];
  const choices = basis.map(item => CHOICE.exec(item)).filter(Boolean)
    .map(([, agentId, projectId, name, project, occupation, note, preselected]) => ({ agentId: unfield(agentId),
      projectId: unfield(projectId), name: unfield(name), project: unfield(project),
      occupation: unfield(occupation) ?? '', note: unfield(note), preselected: preselected === '1' }))
    .filter(item => item.agentId);
  const question = basis.map(item => QUESTION.exec(item)?.[1]).find(value => value !== undefined) ?? '';
  const started = basis.map(item => STARTED.exec(item)?.[1]).find(Boolean) ?? null;
  return { choices, question, started };
}
