import { withoutControls } from '../text/control-characters.js';
import { rateLimitRefusal } from './rate-limit.js';
import { searchableProject, searchableQueries, searchSharedProject } from './shared-project-search.js';
import { VisitorAccessStore } from './store.js';
import { createGuestLinks } from './guest-links.js';

// The one port the visiting assistant reaches this computer's shared project
// knowledge through: a requester from another computer searches one project,
// read-only, rate limited and recorded; and the per-requester mode. Every
// entry answers { ok: true, … } or { ok: false, code } and never throws for
// what a caller passed; nothing a visitor sends reaches the search but the
// project id and the queries.
//
// requester.key is who is asking, and every limit and record hangs on it. The
// caller builds it from an authenticated identity only: 'peer:' and the
// verified TLS fingerprint of the paired device, or 'guest:' and the id of a
// guest link this computer stored. Never from text the other side sent: the
// label and agent name are display text and may change freely.
const MODES = new Set(['ask_only', 'plan', 'auto', 'trusted']);
const DEFAULT_MODE = 'plan';
const REQUESTER_KEY = /^(?:peer:[0-9a-f]{64}|guest:[A-Za-z0-9_-]{8,64})$/;
// Display text longer than this is refused before it is cleaned.
const MAX_LABEL_UNITS = 1000;
const LABEL_CHARS = 120;
const READS_LIMIT = 200;

export function createVisitorAccess({ path = ':memory:', application, now = () => new Date() }) {
  const store = new VisitorAccessStore(path);

  return {
    async searchSharedProject({ projectId, requester, queries } = {}) {
      const who = requesterOf(requester);
      if (!who) return refused('requester_invalid');
      const at = now();
      const project = searchableProject(projectId) ? projectId : '';
      const reservation = store.transaction(() => {
        const code = rateLimitRefusal(store, who.requesterKey, at)
          ?? (project ? null : 'project_invalid') ?? searchableQueries(queries).code ?? null;
        if (code) {
          store.recordRefusal({ ...who, projectId: project, code, at });
          return { code };
        }
        const { queries: searched } = searchableQueries(queries);
        return { id: store.reserveRead({ ...who, projectId: project, queries: searched, at }), queries: searched };
      });
      if (reservation.code) return refused(reservation.code);
      let searched;
      try {
        searched = await searchSharedProject(application, { projectId: project, queries: reservation.queries });
      } catch {
        store.settleRead(reservation.id, { outcome: 'failed', code: 'search_unavailable' });
        return refused('search_unavailable');
      }
      store.settleRead(reservation.id, { outcome: 'answered', bytes: searched.bytes,
        resultsCount: searched.answer.results.reduce((count, result) => count + result.items.length, 0) });
      return searched.answer;
    },

    recentReads({ requesterKey = null, projectId = null, limit } = {}) {
      if (requesterKey !== null && !validKey(requesterKey)) return refused('requester_invalid');
      if (projectId !== null && !searchableProject(projectId)) return refused('project_invalid');
      return { ok: true, reads: store.recentReads({ requesterKey, projectId,
        limit: Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), READS_LIMIT) : READS_LIMIT }) };
    },

    requesterMode(key) {
      if (!validKey(key)) return refused('requester_invalid');
      return { ok: true, mode: store.requester(key)?.mode ?? DEFAULT_MODE };
    },

    setRequesterMode({ key, kind, label, mode, ownDevice } = {}) {
      const shown = displayText(label);
      if (!validKey(key) || !['peer', 'guest'].includes(kind) || !key.startsWith(`${kind}:`) || !shown) {
        return refused('requester_invalid');
      }
      if (!MODES.has(mode)) return refused('mode_unknown');
      if (mode === 'trusted' && !(kind === 'peer' && ownDevice === true)) return refused('mode_not_allowed');
      return { ok: true, requester: store.setRequester({ key, kind, label: shown, mode,
        ownDevice: kind === 'peer' && ownDevice === true, at: now().toISOString() }) };
    },

    // Guest links (deliverable B): created, listed and revoked by the person, opened by a bearer token.
    guestLinks: createGuestLinks({ store, now }),

    close: () => store.close()
  };
}

const refused = code => ({ ok: false, code });
const validKey = key => typeof key === 'string' && REQUESTER_KEY.test(key);

// Display text without control or bidirectional characters, cut to
// LABEL_CHARS code points; null when there is none or it is far too long.
function displayText(value) {
  if (typeof value !== 'string' || value.length > MAX_LABEL_UNITS) return null;
  return [...withoutControls(value)].slice(0, LABEL_CHARS).join('').trim() || null;
}

// The requester as recorded, or null when its key, label or agent name cannot be used.
function requesterOf(requester) {
  if (!validKey(requester?.key)) return null;
  const requesterLabel = displayText(requester.label);
  const agentName = requester.agentName === undefined || requester.agentName === null
    ? null : displayText(requester.agentName);
  if (!requesterLabel || agentName === null && requester.agentName != null) return null;
  return { requesterKey: requester.key, requesterLabel, agentName };
}
