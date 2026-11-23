import { dirname } from 'node:path';

import { sessionClientRecords } from '../agent-kits/session-clients.js';
import { modelProvenance } from '../agents/client-provenance.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';
import { errorReason, queryConversations } from './agent-conversations.js';

// Where one FLA has worked: which clients, which models, how many segments of
// work each (rec#147, Jevons 2026-11-23 「能知道自己之前在哪个客户端哪个
// session 用什么模型工作，要能被统计，如果记录不了要说明给用户」).
//
// A segment is one host session of one conversation — the record FULI already
// keeps (FuliConversationSession, graph 22). Nothing new is stored: this counts
// the conversations this FLA already lists, and says exactly how far the count
// reaches: which scopes could not be read and why, and every way the count was
// cut short. A read that failed is never shown as no work.
//
// Two callers, two scopes:
//   Agents ask through list_agent_conversations (workLocations), so the count
//   has exactly that tool's checks: the caller's client, the FLA's allowed
//   clients, a worker's own layer, and the one scope asked for.
//   The person's console reads their own records across the FLA's active
//   projects (viewAgentWorkLocations).

// The Provider's own bounds (agent_conversation_models.py, store_agent_conversations.py).
export const LIST_LIMIT = 50;
const SESSIONS_PER_CONVERSATION = 5;
const MAX_PROJECTS = 3;
const SEGMENTS_PER_ROW = 10;
const TITLE_BYTES = 96;
// Enough of a native session ID to tell segments apart, never the ID itself.
const SHORT_SESSION = 8;

export const WORK_LOCATIONS_GUIDANCE = 'One row per client and model; segments is how many host sessions of a '
  + 'conversation ran under it. complete is false when a scope could not be read (unavailable) or the count was cut '
  + 'short (truncated): say so, never present the numbers as everything. A row whose model is null stays its own row, '
  + 'with model_reason. model_source requested is the model the client asked for, not proof of what answered. A '
  + 'session that changed model counts under the last one FULI read. Show an unreported value as "-" with its reason, '
  + 'never 0, and never estimate one.';

// The work-location block of a list_agent_conversations answer, from the page
// it already read: no second read, no other scope.
export function listedWorkLocations(answer, { personalProjectId = null, limit = LIST_LIMIT } = {}) {
  return summariseWorkLocations([{ personalProjectId, conversations: answer?.conversations ?? [], limit }]);
}

// The console's view: the FLA's active projects (or the one asked for), each
// read on its own, with the person's own records (ownerInspection).
export async function consoleWorkLocations(application, { personalSpaceId, personalProjectId = null, agentId } = {}) {
  const scopes = personalProjectId ? { projects: [personalProjectId], unavailable: [], truncated: [] }
    : await agentProjects(application, personalSpaceId, agentId);
  const pages = await Promise.all(scopes.projects.map(async project => {
    try {
      const answer = await queryConversations(application, { personalProjectId: project, agentId,
        ownerInspection: true, mode: 'list', after: 0, limit: LIST_LIMIT });
      return { personalProjectId: project, conversations: answer?.conversations ?? [], limit: LIST_LIMIT };
    } catch (error) {
      return { personalProjectId: project, failed: errorReason(error) };
    }
  }));
  const found = summariseWorkLocations(pages, { unavailable: scopes.unavailable, truncated: scopes.truncated });
  return withLocalSessions(application, found);
}

// The FLA's active projects, at most MAX_PROJECTS, and what that leaves out:
// more projects than read, and the FLA's global conversations, which a
// project read does not include. A global-only FLA is read in its global scope.
async function agentProjects(application, personalSpaceId, agentId) {
  try {
    const assignments = await application.listProjectAgentAssignments({ personalSpaceId, agentId, status: 'active' });
    const all = [...new Set((Array.isArray(assignments) ? assignments : []).map(item => item?.personalProjectId).filter(Boolean))];
    if (!all.length) return { projects: [null], unavailable: [], truncated: [] };
    return { projects: all.slice(0, MAX_PROJECTS), unavailable: [],
      truncated: [...(all.length > MAX_PROJECTS ? [{ reason: 'projects_limit', read: MAX_PROJECTS, total: all.length }] : []),
        { reason: 'global_scope_not_counted' }] };
  } catch (error) {
    // Which projects the FLA works in is unknown: say so, and count none.
    return { projects: [], unavailable: [{ scope: 'assignments', reason: errorReason(error) }], truncated: [] };
  }
}

export function summariseWorkLocations(pages, { unavailable = [], truncated = [] } = {}) {
  const rows = new Map();
  const failed = [...unavailable];
  const cut = [...truncated];
  const listed = [];
  let segments = 0;
  for (const page of pages) {
    if (page.failed) {
      failed.push({ personal_project_id: page.personalProjectId ?? null, reason: page.failed });
      continue;
    }
    const conversations = Array.isArray(page.conversations) ? page.conversations : [];
    // A full page means there may be more conversations than were counted.
    if (conversations.length >= (page.limit ?? LIST_LIMIT)) {
      cut.push({ reason: 'conversations_limit', personal_project_id: page.personalProjectId ?? null, read: conversations.length });
    }
    for (const conversation of conversations) {
      listed.push({ conversation, personalProjectId: page.personalProjectId ?? null });
      const sessions = Array.isArray(conversation?.sessions) ? conversation.sessions : [];
      if (sessions.length >= SESSIONS_PER_CONVERSATION) {
        cut.push({ reason: 'sessions_per_conversation', conversation_id: conversation.id, read: sessions.length });
      }
      for (const session of sessions) {
        const client = typeof session?.client === 'string' && session.client.trim() ? session.client.trim() : null;
        const model = typeof session?.model === 'string' && session.model.trim() ? session.model.trim() : null;
        const provenance = modelProvenance(client, model);
        const key = `${client ?? ''}\u0000${model ?? ''}`;
        const row = rows.get(key) ?? { client, model: provenance.model, model_source: provenance.source,
          ...(provenance.reason ? { model_reason: provenance.reason } : {}),
          segments: 0, conversations: new Set(), last_seen: null, recent: [] };
        const seen = session?.last_seen ?? conversation?.last_activity ?? null;
        row.segments += 1;
        row.conversations.add(conversation.id);
        if (seen && (!row.last_seen || seen > row.last_seen)) row.last_seen = seen;
        row.recent.push(segmentView(conversation, session, client, seen, page.personalProjectId ?? null));
        rows.set(key, row);
        segments += 1;
      }
    }
  }
  const newestFirst = (a, b) => String(b ?? '').localeCompare(String(a ?? ''));
  // Continuing this work elsewhere is a different action from going back to a
  // session, so it travels as its own field (Jevons 2026-11-18): the newest
  // conversation that has a prompt, with what it is and which project.
  const latest = listed.filter(item => item.conversation?.continuation_prompt)
    .sort((a, b) => newestFirst(a.conversation.last_activity, b.conversation.last_activity))[0];
  return {
    rows: [...rows.values()]
      .map(({ conversations: ids, recent, ...row }) => {
        const ordered = recent.sort((a, b) => newestFirst(a.when, b.when));
        return { ...row, conversations: ids.size, recent: ordered.slice(0, SEGMENTS_PER_ROW),
          ...(ordered.length > SEGMENTS_PER_ROW ? { recent_more: ordered.length - SEGMENTS_PER_ROW } : {}) };
      })
      // Most work first; a tie goes to whichever was worked on most recently.
      .sort((a, b) => b.segments - a.segments || newestFirst(a.last_seen, b.last_seen)),
    segments,
    conversations_read: listed.length,
    complete: !failed.length && !cut.length,
    ...(failed.length ? { unavailable: failed } : {}),
    ...(cut.length ? { truncated: cut } : {}),
    continuation: latest ? { conversation_id: latest.conversation.id, personal_project_id: latest.personalProjectId,
      ...(titleOf(latest.conversation) ? { title: titleOf(latest.conversation) } : {}),
      prompt: latest.conversation.continuation_prompt, opens: 'new_session', leaves_original: true } : null,
    guidance: WORK_LOCATIONS_GUIDANCE
  };
}

// One segment as a person reads it: where it ran, when, which work it belongs
// to and how far that work got. The native session ID travels whole so the
// console can offer to open that very session.
function segmentView(conversation, session, client, when, personalProjectId) {
  const title = titleOf(conversation);
  const sessionId = typeof session?.session_id === 'string' && session.session_id ? session.session_id : null;
  return { conversation_id: conversation?.id ?? null, personal_project_id: personalProjectId, client,
    session_id: sessionId, session_short: sessionId ? sessionId.slice(0, SHORT_SESSION) : null,
    when: when ?? null, status: conversation?.status ?? null,
    ...(session?.branch ? { branch: session.branch } : {}), ...(title ? { title } : {}) };
}

function titleOf(conversation) {
  const words = conversation?.summary || conversation?.title || '';
  return words ? utf8Preview(singleLine(words), TITLE_BYTES, text => Buffer.byteLength(text)) : '';
}

// Whether this computer's own hook saw each segment's native session: only a
// session recorded here can be opened here (Jevons 2026-11-18). A record is
// proof; its absence is not proof of another computer, since only Claude Code's
// hook writes one today (src/agents/claude-code/session-client.js), so it is
// left unknown (null) rather than called elsewhere.
function withLocalSessions(application, found) {
  const runtimeConfigPath = application?.runtimeConfigPath;
  const records = typeof runtimeConfigPath === 'string' && runtimeConfigPath
    ? sessionClientRecords(dirname(runtimeConfigPath)) : null;
  const local = segment => {
    if (!records || !segment.client || !segment.session_id) return null;
    try { return records.read(segment.client, segment.session_id) ? true : null; } catch { return null; }
  };
  return { ...found, rows: found.rows.map(row => ({ ...row,
    recent: row.recent.map(segment => ({ ...segment, on_this_computer: local(segment) })) })) };
}
