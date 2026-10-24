import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { receiptSummary, receiptText, sessionRecordsUrl } from '../agents/identity-receipt.js';
import { CATEGORY, CONFIRMATION } from '../agents/turn-receipt.js';
import { notRecordedReason } from '../conversations/transcript-capture-gap.js';
import { localClockTime } from '../text/clock-time.js';
import { providerReaderFields, taskKnowledgeReader } from './knowledge-reader.js';
import { requiredString } from '../validation/values.js';

// "本会话记了什么" (rec#5 C6): one host session's records in three groups,
// numbered once here so the console page and the Agent's answer list the same
// items with the same numbers, types, summaries and links. Transcript turns
// the session saved, knowledge its turns created or updated (with 待确认 /
// 已确认), and the words that became preference evidence. Stretches where
// nothing was recorded (paused, stopped or otherwise off) are shown as
// "HH:mm～HH:mm 暂停记录" / "未记录" and hold no record.
//
// The console is the person's own view and lists everything, read through
// its human-review port (ownerReads). An Agent reads only its own session,
// only what that session wrote while in the Agent's own project (C6-5), and
// as its task's FLA or plain session, so the Provider leaves out every other
// FLA's knowledge: records a turn wrote in another project never enter this
// project's context, not even as a count.

const GROUPS = Object.freeze(['transcript', 'knowledge', 'preference_evidence']);
const MAX_SESSION_ID = 256;
const MAX_CLIENT = 32;

// sourceApplication may be left out: a receipt's short link names only the
// session, and the Provider finds its client (or says two clients share it).
export async function readSessionRecords(application, ownerReads, { personalSpaceId, sourceApplication = null, sessionId }) {
  if (personalSpaceId !== application.config.personal.spaceId) {
    invalid('Session records are read in the active personal space');
  }
  const sessionIdValue = requiredString(sessionId, 'sessionId', MAX_SESSION_ID);
  const read = await providerRead(application, { sessionId: sessionIdValue,
    sourceApplication: sourceApplication ? client(sourceApplication) : null }, ownerReads.sessionRecords);
  return sessionRecordsView(application, { sourceApplication: read.source_application ?? null, sessionId: sessionIdValue }, read);
}

// The caller's own session, as the Agent tool reads it: entries of the turns
// it worked in this same project, renumbered, with no content of the others,
// as the numbered lines the Agent repeats.
export async function readOwnSessionRecords(application, { taskContextToken, sourceApplication }) {
  const task = await application.taskContextRegistry.context(requiredString(taskContextToken, 'taskContextToken', 160),
    client(sourceApplication));
  const session = { sourceApplication: task.sourceApplication, sessionId: task.sessionId };
  const reader = providerReaderFields(taskKnowledgeReader(task));
  const read = await providerRead(application, session,
    body => application.personal.readSessionRecords({ ...body, ...reader }));
  const view = sessionRecordsView(application, session, withinProject(read, task.personalProjectId ?? null));
  // The numbered lines carry every entry once; the same entries again as
  // data would only double what the answer costs.
  return { total: view.total, truncated: view.truncated, url: view.session.url, markdown: sessionRecordsMarkdown(view) };
}

async function providerRead(application, session, readRecords) {
  const read = await readRecords({ personal_space_id: application.config.personal.spaceId,
    source_application: session.sourceApplication, session_id: session.sessionId });
  if (!Array.isArray(read?.turns) || !Array.isArray(read?.items)) {
    throw new TypeError('Provider did not return the session records');
  }
  return read;
}

// Only what turns in this same project wrote; no project is a scope of its
// own, not one every project sees. A stretch that only another project's
// turns hold is left out too: even its times are that project's.
// An item is kept when one of its sources is this project's, shown through
// the first such source, so another project's earlier citation never hides
// this project's own evidence.
function withinProject(read, projectId) {
  const visible = id => (id ?? null) === projectId;
  const turns = read.turns.map(turn => visible(turn.personal_project_id) ? turn
    : { ...turn, hidden: true, messages: [] });
  const items = read.items.map(item => ({ ...item, sources: itemSources(item).filter(source => visible(source.origin_project_id)) }))
    .filter(item => item.sources.length).map(item => ({ ...item, ...item.sources[0] }));
  return { ...read, turns, items, projects: (read.projects ?? []).filter(project => project.id === projectId) };
}

// Every episode that wrote or cited an item, oldest first; an older Provider
// named only the first, at the top.
function itemSources(item) {
  return item.sources?.length ? item.sources : [{ change: item.change, episode_id: item.episode_id, task_id: item.task_id,
    recorded_at: item.recorded_at, origin_project_id: item.origin_project_id, conversation_id: item.conversation_id,
    excerpt: item.excerpt }];
}

function sessionRecordsView(application, session, read) {
  const projects = new Map((read.projects ?? []).map(project => [project.id, project]));
  const project = id => id ? projects.get(id) ?? { id, name: null, temporary: false } : null;
  const link = key => sessionRecordsUrl(application, session, key);
  const grouped = {
    transcript: read.turns.filter(turn => !turn.hidden && !turn.capture_off && turn.messages.length).map(turn => ({
      group: 'transcript', key: `turn:${turn.task_id}`, kind: 'turn', type: '会话原文',
      summary: oneLine(turnWords(turn)), at: turn.created_at, project: project(turn.personal_project_id),
      detail: { messages: turn.messages, conversation_id: turn.conversation_id ?? null,
        items: read.items.filter(item => itemSources(item).some(source => source.task_id === turn.task_id)).map(itemKey) } })),
    knowledge: read.items.filter(item => !item.profile_aspect && item.change !== 'evidence').map(item => itemEntry(item,
      'knowledge', `${item.change === 'updated' ? '更新' : '新增'} ${CATEGORY[item.category] ?? '知识'}`)),
    preference_evidence: read.items.filter(item => item.profile_aspect).map(item => itemEntry(item,
      'preference_evidence', '偏好证据', item.excerpt || item.content))
  };
  function itemEntry(item, group, type, words = item.content || item.title) {
    return { group, key: itemKey(item), kind: item.item_kind, type, summary: oneLine(words),
      status: item.confirmation_status, at: item.recorded_at, project: project(item.origin_project_id),
      turn: turnKey(item.task_id), detail: { item, sources: itemSources(item).map(source => ({
        episode_id: source.episode_id, turn: turnKey(source.task_id) })) } };
  }
  let number = 0;
  const entries = GROUPS.flatMap(group => grouped[group]
    .sort((left, right) => time(left.at) - time(right.at))
    .map(entry => ({ number: ++number, ...entry, link: link(entry.key) })));
  return { session: { ...session, url: link(null),
    ...(read.deletion_target_id ? { deletionTargetId: read.deletion_target_id } : {}) }, total: entries.length, entries,
    stretches: notRecordedStretches(read.turns), truncated: Boolean(read.truncated),
    // Two or more clients have a session with this ID: the reader picks one.
    ...(read.clients?.length > 1 ? { clients: read.clients } : {}) };
}

const itemKey = item => `${item.item_kind}:${item.item_id}`;
const turnKey = taskId => taskId ? `turn:${taskId}` : null;

function turnWords(turn) {
  return turn.messages.find(message => message.role === 'user')?.text ?? turn.messages[0]?.text ?? '';
}

// One line, for a list row; the full words are the item's detail.
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Where the session recorded nothing: turns whose checkpoint says capture was
// off, from their start to the next turn's, and journal markers of skipped
// bytes, from the session's last saved event before them. Overlapping or
// touching stretches merge. Session-layer reasons (paused, stopped) read
// 暂停记录. Only what the reader may see sets a boundary: when the next turn
// is another project's, the stretch ends at its own last evidence instead of
// guessing it lasted until then.
function notRecordedStretches(turns) {
  const segments = [];
  turns.forEach((turn, index) => {
    if (turn.hidden) return;
    const next = turns[index + 1] && !turns[index + 1].hidden ? turns[index + 1].created_at : null;
    if (turn.capture_off) {
      const last = [turn.created_at, ...turn.not_recorded.map(marker => marker.created_at)].filter(Boolean).sort().at(-1);
      segments.push({ from: turn.created_at, to: next ?? last, reasons: [turn.capture_off.layer === 'session'
        ? 'session' : turn.capture_off.reason] });
      return;
    }
    for (const marker of turn.not_recorded) {
      const reason = notRecordedReason(marker.content);
      if (!reason) continue;
      segments.push({ from: marker.after ?? turn.created_at, to: marker.created_at ?? turn.created_at,
        reasons: [reason.startsWith('session_') ? 'session' : reason] });
    }
  });
  const merged = [];
  for (const segment of segments.filter(item => item.from).sort((left, right) => time(left.from) - time(right.from))) {
    const previous = merged.at(-1);
    if (previous && time(segment.from) <= time(previous.to)) {
      if (time(segment.to) > time(previous.to)) previous.to = segment.to;
      previous.reasons = [...new Set([...previous.reasons, ...segment.reasons])];
    } else merged.push({ ...segment });
  }
  return merged.map(({ from, to, reasons }) => ({ from, to, paused: reasons.includes('session'),
    reasons: reasons.filter(reason => reason !== 'session') }));
}

// The Agent's answer: the same numbered entries as the page, one line each.
function sessionRecordsMarkdown(view) {
  const heading = view.total ? `FULI 本会话已记录 ${view.total} 项` : 'FULI 本会话还没有记录任何内容';
  const lines = [`${heading}（[查看清单](<${view.session.url}>)）：`];
  const stretches = [...view.stretches];
  for (const entry of view.entries) {
    while (entry.group === 'transcript' && stretches.length && time(stretches[0].from) <= time(entry.at)) {
      lines.push(stretchLine(stretches.shift()));
    }
    const status = entry.status ? `·${CONFIRMATION[entry.status] ?? '待确认'}` : '';
    lines.push(`${entry.number}. ${entry.type}${status}｜${clock(entry.at)}｜${projectLabel(entry.project)}`
      + `｜「${receiptSummary(entry.summary)}」｜[查看](<${entry.link}>)`);
  }
  lines.push(...stretches.map(stretchLine));
  // The list is bounded on the console too, so this never promises more there.
  if (view.truncated) lines.push('会话较长，只列出了最近的记录；更早的记录没有列出。');
  return lines.join('\n');
}

function stretchLine(stretch) {
  return `— ${stretchLabel(stretch)}，这段没有任何记录`;
}

function stretchLabel(stretch) {
  return `${clock(stretch.from)}～${clock(stretch.to)} ${stretch.paused ? '暂停记录' : '未记录'}`;
}

function projectLabel(project) {
  if (!project) return '无项目';
  return project.temporary ? '临时会话项目' : `项目 ${receiptText(project.name || project.id)}`;
}

function clock(value) {
  return localClockTime(value) ?? '--:--';
}

function time(value) {
  const at = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(at) ? 0 : at;
}

// The Provider accepts only the clients it knows; this only bounds the value.
function client(value) {
  return requiredString(value, 'sourceApplication', MAX_CLIENT);
}

function invalid(message) {
  throw new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
