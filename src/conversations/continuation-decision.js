import { sep } from 'node:path';

import { sourceLabel } from '../agent-kits/session-clients.js';
import { modelProvenance } from '../agents/client-provenance.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';

// When a reply says it is continuing earlier work, and what it says (rec#147,
// Jevons 2026-11-23). A session that simply keeps working says nothing: the
// line is for the moment work moves, and only when the move is certain.
//
// Certain means one of exactly two things:
//   stated     the person brought a FULI continuation prompt naming this FLA
//              and a conversation of it, or resumed that conversation
//              explicitly. Naming an FLA for a new task only says who works on
//              it; it continues nothing, so it shows nothing.
//   same_branch FULI recognised the same work of the same project by a fact it
//              can name: another session of this FLA within the last seven
//              days, in the same repository folder, on the same Git branch,
//              where that branch is not one everything sits on. Two
//              candidates that disagree are not certain, so nothing is shown.
// Anything else shows no continuation line, and no explanation of why not.

// Long-lived branches many people share: two sessions on one prove nothing
// about working on one thing.
const SHARED_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'default', 'head',
  'release', 'staging', 'test', 'prod', 'production', 'gh-pages']);
export const RECOGNITION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const TITLE_BYTES = 96;
// Enough of a native session ID to tell this FLA's sessions apart in a line,
// never enough to be mistaken for the ID itself.
const SHORT_SESSION = 8;

export function sharedBranch(name) {
  return SHARED_BRANCHES.has(String(name ?? '').trim().toLocaleLowerCase());
}

// conversation: this session's beginConversation answer. session: this
// session ({ client, sessionId }). stated: the conversation ID a continuation
// prompt named for this FLA, or null. repository: { branch, root } of this
// session's folder, or null. rows: this FLA's recent conversations in this
// scope as list_agent_conversations returns them, each with its sessions.
export function continuationDecision(conversation, {
  session = null, stated = null, repository = null, rows = [], personalProjectId = null, now = Date.now()
} = {}) {
  if (!conversation || ['unassigned', 'capture_disabled'].includes(conversation.status)) return quiet('no_conversation');
  if (conversation.status !== 'saved') return quiet('history_unavailable');
  // The native session already had a conversation bound to it, so this turn is
  // the same session going on. Nothing moved; say nothing.
  if (conversation.recovered_from) return quiet('same_session');
  const others = (Array.isArray(rows) ? rows : []).filter(row => row?.id && row.id !== conversation.conversation_id);
  if (stated) {
    const row = others.find(item => item.id === stated);
    if (!row) return quiet(stated === conversation.conversation_id ? 'same_session' : 'stated_source_unavailable');
    return statedContinuation(row, { session, personalProjectId });
  }
  if (!repository?.branch || !repository.root) return quiet('branch_unknown');
  if (sharedBranch(repository.branch)) return quiet('shared_branch');
  const since = now - RECOGNITION_WINDOW_MS;
  const matches = others.flatMap(row => (row.sessions ?? [])
    .filter(item => !ownSession(item, session) && item?.branch === repository.branch
      && inside(item.working_directory, repository.root) && Date.parse(item.last_seen ?? '') >= since)
    .map(item => ({ row, item })));
  if (!matches.length) return quiet(others.length ? 'different_work' : 'no_earlier_work');
  // Several pieces of work on this branch may be several things; FULI does not
  // pick one, and says nothing rather than guessing (rec#147).
  if (new Set(matches.map(match => match.row.id)).size > 1) return quiet('ambiguous');
  const newest = matches.sort((a, b) => String(b.item.last_seen).localeCompare(String(a.item.last_seen)))[0];
  return { show: true, evidence: 'same_branch',
    from: { ...fromRow(newest.row, newest.item, personalProjectId), branch: repository.branch }, context: 'not_loaded' };
}

// A conversation the person named or resumed. The session that worked on it
// last stands for it; a record read without its sessions names where its
// latest summary came from and leaves the model unread rather than guessed.
// A conversation this very session already works on continues nothing.
export function statedContinuation(row, { session = null, personalProjectId = null } = {}) {
  if ((row.sessions ?? []).some(item => ownSession(item, session))) return quiet('same_session');
  const newest = [...(row.sessions ?? [])].sort((a, b) => String(b?.last_seen ?? '').localeCompare(String(a?.last_seen ?? '')))[0] ?? null;
  return { show: true, evidence: 'stated_by_user', from: fromRow(row, newest, personalProjectId), context: 'not_loaded' };
}

function quiet(reason) {
  return { show: false, reason };
}

function ownSession(item, session) {
  return Boolean(session?.sessionId) && item?.client === session.client && item?.session_id === session.sessionId;
}

// A folder inside this repository: another clone, another computer's path or
// an unrecorded folder is not the same repository.
function inside(folder, root) {
  if (typeof folder !== 'string' || !folder) return false;
  return folder === root || folder.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

// One earlier piece of work as a line names it: which client, which session,
// when, on what model, in which project and how far it got.
function fromRow(row, item, personalProjectId) {
  const origin = item ?? row.summary_source ?? row.title_source ?? null;
  const client = origin?.client ?? null;
  const model = item ? modelProvenance(client, item.model) : { model: null, source: 'unknown', reason: 'session_unread' };
  const words = row.summary || row.title || '';
  return { conversation_id: row.id, ...where(client),
    session_id: origin?.session_id ?? null, session_short: shortSession(origin?.session_id),
    when: item?.last_seen ?? row.last_activity ?? null,
    model: model.model, model_source: model.source, ...(model.reason ? { model_reason: model.reason } : {}),
    personal_project_id: personalProjectId, status: row.status ?? null,
    ...(words ? { title: utf8Preview(singleLine(words), TITLE_BYTES, text => Buffer.byteLength(text)) } : {}) };
}

// A client FULI never recorded gets no invented label: the surface decides
// what to show for an unknown one in its own language.
function where(client) {
  const known = typeof client === 'string' && client && client !== 'other' ? client : null;
  return { client: client ?? null, client_label: known ? sourceLabel(known) : null };
}

function shortSession(sessionId) {
  return typeof sessionId === 'string' && sessionId ? sessionId.slice(0, SHORT_SESSION) : null;
}

// How much of the earlier conversation a resume actually delivered, counted
// from what the recovery window holds — never an estimate (rec#147: a chat of
// 3000 messages must not look the same as one of five). `folded_events` is the
// Provider's own compaction boundary: every event up to it went into the
// digest, which keeps the raw and can still be paged with read_agent_conversation.
// Counts only: each surface words them in its own language.
export function carriedContext(recovery, { compacted = false, foldedThrough = null, revision = null } = {}) {
  const folded = Number.isSafeInteger(foldedThrough) && foldedThrough > 0 ? foldedThrough : null;
  const some = compacted || Boolean(folded);
  const base = { folded: some ? 'some' : 'none', ...(folded ? { folded_events: folded } : {}),
    ...(Number.isSafeInteger(revision) && revision > 0 ? { conversation_events: revision } : {}) };
  if (!recovery) return { summary: false, recent_messages: 0, ...base };
  const omitted = Number.isSafeInteger(recovery.messages_omitted) ? recovery.messages_omitted : 0;
  return { summary: Boolean(recovery.latest_checkpoint),
    recent_messages: Array.isArray(recovery.messages) ? recovery.messages.length : 0,
    ...(omitted ? { already_in_this_session: omitted } : {}), ...base,
    ...(recovery.compaction_summary ? { client_compaction_summary: true } : {}),
    ...(recovery.truncated === true || recovery.scan_truncated === true ? { window_truncated: true } : {}) };
}
