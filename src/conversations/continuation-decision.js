import { sourceLabel } from '../agent-kits/session-clients.js';
import { modelProvenance } from '../agents/client-provenance.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';

// When a reply says it is continuing earlier work, and what it says (rec#147,
// Jevons 2026-11-23). A session that simply keeps working says nothing: the
// line is for the moment work moves, and only when the move is certain.
//
// Certain means one of exactly two things:
//   stated   the person said so this turn — a named FLA (#FLA / @name), a
//            checkpoint continuation prompt, or an explicit resume.
//   same_work FULI recognised the same work of the same project by a fact it
//            can name: another recent session of this same FLA on the same
//            non-shared Git branch. Two candidates that disagree are not
//            certain, so nothing is shown.
// Anything else — a new chat about something else, no earlier work, history
// that could not be read — shows no continuation line.

// A branch so many people share that two sessions on it prove nothing about
// working on one thing. A project's own long-lived trunk belongs here.
const SHARED_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'default', 'head']);

const TITLE_BYTES = 96;
// Enough of a native session ID to tell this FLA's sessions apart in a line,
// never enough to be mistaken for the ID itself.
const SHORT_SESSION = 8;

export const CONTINUATION_GUIDANCE = 'continuation describes work this turn picks up from another session or client. '
  + 'Say it in your own words at the start of the reply, using only the fields given: never infer a model, '
  + 'a time or how much context was carried. When it is absent, this turn continues nothing visible to the person '
  + 'and the reply opens with no continuation line.';

// Why no line is shown. The person sees `history_unavailable` and
// `ambiguous`: both mean FULI knows something is missing, which is not the
// same as there being nothing.
export const NO_CONTINUATION = Object.freeze({
  same_session: 'same_session',
  no_conversation: 'no_conversation',
  history_unavailable: 'history_unavailable',
  no_earlier_work: 'no_earlier_work',
  different_work: 'different_work',
  ambiguous: 'ambiguous'
});

// The one quiet reason the person should still hear: FULI found earlier work
// of this FLA on this branch but more than one piece of it, so it names none.
const QUIET_NOTE = Object.freeze({
  ambiguous: '这位 FLA 在同一分支上有不止一段最近的工作，分不清接的是哪一段，所以没写续接。'
});

// A conversation FULI could not read says so rather than looking like a fresh
// start; `status` is beginConversation's own ('unsaved', 'deferred', …).
function unreadable(conversation) {
  return { show: false, reason: NO_CONTINUATION.history_unavailable, status: conversation.status ?? null,
    detail: conversation.reason ?? null,
    note: '这一轮没能读到这位 FLA 的历史记录，所以没写续接；不是「没有历史」。' };
}

export function continuationDecision(conversation, { branch = null, statedByUser = false, personalProjectId = null } = {}) {
  if (!conversation || conversation.status === 'unassigned') return quiet(NO_CONTINUATION.no_conversation);
  if (conversation.status !== 'saved') {
    return conversation.status === 'capture_disabled' ? quiet(NO_CONTINUATION.no_conversation) : unreadable(conversation);
  }
  // The native session already had a conversation bound to it, so this turn is
  // the same session going on. Nothing moved; say nothing.
  if (conversation.recovered_from) return quiet(NO_CONTINUATION.same_session);
  const elsewhere = Array.isArray(conversation.active_elsewhere) ? conversation.active_elsewhere : [];
  const pointer = conversation.recent_conversation ?? null;
  if (!elsewhere.length && !pointer) return quiet(NO_CONTINUATION.no_earlier_work);
  const picked = statedByUser ? stated(elsewhere, pointer) : recognised(elsewhere, branch);
  if (!picked.source) return quiet(picked.reason);
  // Which project the work belongs to and how far it got, so one continuation
  // line answers 归哪个项目、做到哪一步 without a second read (Jevons 2026-11-18).
  // The owner is this turn's own FLA, already named by the receipt.
  const checkpoint = conversation.recovery?.latest_checkpoint ?? null;
  return { show: true, evidence: picked.evidence,
    from: { ...picked.source, personal_project_id: personalProjectId,
      ...(checkpoint?.status ? { status: checkpoint.status } : {}) },
    carried: carriedContext(conversation.recovery, { compacted: conversation.compacted }),
    guidance: CONTINUATION_GUIDANCE };
}

function quiet(reason) {
  return { show: false, reason, ...(QUIET_NOTE[reason] ? { note: QUIET_NOTE[reason] } : {}) };
}

// The person said to continue here, so the only question is which earlier work
// they meant: the session this FLA worked in most recently, and when none is
// recent, the last conversation of this FLA in this project.
function stated(elsewhere, pointer) {
  const newest = [...elsewhere].sort(byLastSeen)[0];
  if (newest) return { evidence: 'stated_by_user', source: fromSession(newest) };
  return pointer ? { evidence: 'stated_by_user', source: fromPointer(pointer) }
    : { reason: NO_CONTINUATION.no_earlier_work };
}

// The same work, recognised rather than told: another recent session of this
// same FLA, in this same project, on this same Git branch, where that branch
// is not one everything sits on. A branch is a fact a person can check; two
// sessions on different branches, or on a shared trunk, are not evidence.
function recognised(elsewhere, branch) {
  const working = typeof branch === 'string' ? branch.trim() : '';
  if (!working || SHARED_BRANCHES.has(working.toLocaleLowerCase())) {
    return { reason: NO_CONTINUATION.different_work };
  }
  const matches = elsewhere.filter(row => typeof row?.branch === 'string' && row.branch.trim() === working);
  if (!matches.length) return { reason: NO_CONTINUATION.different_work };
  // Several sessions on this branch may be several pieces of work; FULI does
  // not pick one, and says it could not rather than guessing (rec#147).
  if (new Set(matches.map(row => row.conversation_id)).size > 1) {
    return { reason: NO_CONTINUATION.ambiguous };
  }
  return { evidence: 'same_branch', source: { ...fromSession([...matches].sort(byLastSeen)[0]), branch: working } };
}

const byLastSeen = (a, b) => String(b?.last_seen ?? '').localeCompare(String(a?.last_seen ?? ''));

// One earlier work segment as a line names it: which client, which session,
// when, and the model it ran on — or why that model is unknown.
function fromSession(row) {
  const model = modelProvenance(row.client, row.model);
  return { conversation_id: row.conversation_id, ...where(row.client),
    session_id: row.session_id ?? null, session_short: shortSession(row.session_id), when: row.last_seen ?? null,
    model: model.model, model_source: model.source, ...(model.reason ? { model_reason: model.reason } : {}),
    ...(row.working_directory ? { working_directory: row.working_directory } : {}),
    ...(row.title ? { title: title(row.title) } : {}) };
}

// The last conversation of this FLA when no session of it is recent: the
// Provider keeps which client and session wrote its opening words, and no
// model, so the model is honestly unknown rather than carried over from here.
function fromPointer(pointer) {
  const client = pointer.client ?? null;
  return { conversation_id: pointer.id, ...where(client),
    session_id: pointer.session_id ?? null, session_short: shortSession(pointer.session_id),
    when: pointer.updated_at ?? null, model: null, model_source: 'unknown',
    model_reason: client ? modelProvenance(client, null).reason : 'client_not_recorded',
    ...(pointer.title ? { title: title(pointer.title) } : {}) };
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

function title(value) {
  return utf8Preview(singleLine(value), TITLE_BYTES, text => Buffer.byteLength(text));
}

// How much of the earlier conversation this turn actually received, counted
// from what the recovery window holds — never an estimate (rec#147: a chat of
// 3000 messages must not look the same as one of five). `folded_events` is the
// Provider's own compaction boundary: every event up to it went into the
// digest, which keeps the raw and can still be paged with read_agent_conversation.
export function carriedContext(recovery, { compacted = false, foldedThrough = null, revision = null } = {}) {
  const folded = Number.isSafeInteger(foldedThrough) && foldedThrough > 0 ? foldedThrough : null;
  const some = compacted || Boolean(folded);
  if (!recovery) {
    return { summary: false, recent_messages: 0, folded: some ? 'some' : 'none',
      ...(folded ? { folded_events: folded } : {}), note: '没有带上下文。' };
  }
  const messages = Array.isArray(recovery.messages) ? recovery.messages.length : 0;
  const omitted = Number.isSafeInteger(recovery.messages_omitted) ? recovery.messages_omitted : 0;
  const summary = Boolean(recovery.latest_checkpoint);
  return { summary, recent_messages: messages,
    ...(omitted ? { already_in_this_session: omitted } : {}),
    folded: some ? 'some' : 'none',
    ...(folded ? { folded_events: folded } : {}),
    ...(Number.isSafeInteger(revision) && revision > 0 ? { conversation_events: revision } : {}),
    ...(recovery.compaction_summary ? { client_compaction_summary: true } : {}),
    ...(recovery.truncated === true || recovery.scan_truncated === true ? { window_truncated: true } : {}),
    note: carriedNote(summary, messages, folded, some) };
}

function carriedNote(summary, messages, folded, some) {
  const parts = [summary ? '带上了上次的工作小结' : '没有上次的工作小结',
    messages ? `最近 ${messages} 条原文` : '没有原文'];
  if (folded) parts.push(`更早的 ${folded} 条已折叠进摘要，原文仍可用 read_agent_conversation 翻出来`);
  else if (some) parts.push('更早的已折叠进摘要，原文仍可用 read_agent_conversation 翻出来');
  return `${parts.join('，')}。`;
}
