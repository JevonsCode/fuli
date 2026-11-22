import { modelProvenance } from '../agents/client-provenance.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';

// Where one FLA has worked: which clients, which models, how many segments of
// work each (rec#147, Jevons 2026-11-23 「能知道自己之前在哪个客户端哪个
// session 用什么模型工作，要能被统计」).
//
// A segment is one host session of one conversation — the record FULI already
// keeps (FuliConversationSession, graph 22). Nothing new is stored: this reads
// the conversations this Agent already lists and counts their sessions, so it
// always says how many conversations it counted rather than implying a
// lifetime total it did not read.
//
// Counts are attributed to the Agent whose conversations they are, never
// spread over everyone who appears in them; a value no client reported stays
// unreported, and a surface shows it as `-` with its reason.

// A page of conversations is one Provider round trip; the Agent and the
// console both read the same bounded window.
const DEFAULT_CONVERSATIONS = 50;
const MAX_CONVERSATIONS = 200;
const MAX_ROWS = 20;
const MAX_RECENT = 10;
const TITLE_BYTES = 96;
// Enough of a native session ID to tell segments apart, never the ID itself.
const SHORT_SESSION = 8;

export const WORK_LOCATIONS_GUIDANCE = 'Segments counted from the conversations read, not a lifetime total: '
  + 'conversations_read and partial say how far the count reaches. A row whose model is null is its own row and is '
  + 'never merged into a named one; model_reason says why it is unknown. Show an unreported value as "-" with its '
  + 'reason, never as 0, and never estimate a model or a count FULI was not given.';

export async function agentWorkLocations(application, {
  personalSpaceId, personalProjectId = null, agentId, limit = DEFAULT_CONVERSATIONS
} = {}) {
  const read = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : DEFAULT_CONVERSATIONS, 1), MAX_CONVERSATIONS);
  const answer = await application.personal.conversation('query', {
    personal_space_id: personalSpaceId, personal_project_id: personalProjectId, agent_id: agentId,
    source_application: null, mode: 'list', after: 0, limit: read
  });
  return summariseWorkLocations(Array.isArray(answer?.conversations) ? answer.conversations : [], read);
}

export function summariseWorkLocations(conversations, read = DEFAULT_CONVERSATIONS) {
  const rows = new Map();
  const recent = [];
  let segments = 0;
  for (const conversation of conversations) {
    for (const session of conversation?.sessions ?? []) {
      const client = typeof session?.client === 'string' && session.client.trim() ? session.client.trim() : 'other';
      const model = typeof session?.model === 'string' && session.model.trim() ? session.model.trim() : null;
      const provenance = modelProvenance(client, model);
      const key = `${client}\u0000${model ?? ''}`;
      const row = rows.get(key) ?? { client, model: provenance.model, model_source: provenance.source,
        ...(provenance.reason ? { model_reason: provenance.reason } : {}),
        segments: 0, conversations: new Set(), last_seen: null };
      row.segments += 1;
      row.conversations.add(conversation.id);
      const seen = session?.last_seen ?? conversation?.last_activity ?? null;
      if (seen && (!row.last_seen || seen > row.last_seen)) row.last_seen = seen;
      rows.set(key, row);
      segments += 1;
      recent.push(segmentView(conversation, session, client, provenance, seen));
    }
  }
  recent.sort((a, b) => String(b.when ?? '').localeCompare(String(a.when ?? '')));
  return {
    rows: [...rows.values()]
      .map(({ conversations: ids, ...row }) => ({ ...row, conversations: ids.size }))
      // Most work first; a tie goes to whichever was worked on most recently.
      .sort((a, b) => b.segments - a.segments || String(b.last_seen ?? '').localeCompare(String(a.last_seen ?? '')))
      .slice(0, MAX_ROWS),
    segments,
    conversations_read: conversations.length,
    // More conversations exist than were counted, so the totals are a floor.
    partial: conversations.length >= read,
    recent: recent.slice(0, MAX_RECENT),
    guidance: WORK_LOCATIONS_GUIDANCE
  };
}

// One segment as a person reads it: where it ran, when, on what, which work it
// belongs to and how far that work got. The native session ID travels whole so
// the console can offer to open that very session; the short form is for text.
function segmentView(conversation, session, client, provenance, when) {
  const title = conversation?.summary || conversation?.title || '';
  return { conversation_id: conversation?.id ?? null, client,
    session_id: typeof session?.session_id === 'string' ? session.session_id : null,
    session_short: typeof session?.session_id === 'string' ? session.session_id.slice(0, SHORT_SESSION) : null,
    model: provenance.model, model_source: provenance.source,
    ...(provenance.reason ? { model_reason: provenance.reason } : {}),
    when: when ?? null, status: conversation?.status ?? null,
    ...(session?.branch ? { branch: session.branch } : {}),
    ...(title ? { title: utf8Preview(singleLine(title), TITLE_BYTES, text => Buffer.byteLength(text)) } : {}) };
}
