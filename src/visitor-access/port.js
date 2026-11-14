import { withoutControls } from '../text/control-characters.js';
import { rateLimitRefusal } from './rate-limit.js';
import { searchableProject, searchableQueries, searchSharedProject, sharedCard } from './shared-project-search.js';
import { VisitorAccessStore } from './store.js';
import { createGuestLinks } from './guest-links.js';

// The one port the visiting assistant reaches this computer's shared project
// knowledge through: a requester from another computer searches one project
// or looks at who leads it, read-only, rate limited and recorded alike; and the
// per-requester mode. Every
// entry answers { ok: true, … } or { ok: false, code } and never throws for
// what a caller passed; nothing a visitor sends reaches the search but the
// project id and the queries.
//
// requester.key is who is asking, and every limit and record hangs on it. The
// caller builds it from an authenticated identity only: 'peer:' and the
// verified TLS fingerprint of the paired device, or 'guest:' and the id of a
// guest link this computer stored. Never from text the other side sent: the
// label and agent name are display text and may change freely; they never
// decide whether a requester is valid (only the key does), so no name can keep
// an attempt out of the limits and the record.
//
// A host that must check something with the Provider (the share's lead, the
// project's name) passes that check in (confirm, card): it runs only after the
// attempt is reserved, so a requester past its limits causes no Provider read.
const MODES = new Set(['ask_only', 'plan', 'auto', 'trusted']);
const DEFAULT_MODE = 'plan';
const REQUESTER_KEY = /^(?:peer:[0-9a-f]{64}|guest:[A-Za-z0-9_-]{8,64})$/;
// Display text is cut to this many UTF-16 units before it is cleaned.
const MAX_LABEL_UNITS = 1000;
const LABEL_CHARS = 120;
const READS_LIMIT = 200;

export function createVisitorAccess({ path = ':memory:', application, now = () => new Date(), warn }) {
  const store = new VisitorAccessStore(path, { warn });

  return {
    // confirm(): optional; resolves null to go on, or a refusal code.
    async searchSharedProject({ projectId, requester, queries, confirm = async () => null } = {}) {
      const reservation = reserve({ projectId, requester, action: 'search', asked: () => searchableQueries(queries) });
      if (reservation.code) return refused(reservation.code);
      const refusal = await confirmed(confirm);
      if (refusal) return settle(reservation.id, { outcome: 'refused', code: refusal }, refused(refusal));
      let searched;
      try {
        searched = await searchSharedProject(application, { projectId: reservation.projectId, queries: reservation.queries });
      } catch {
        return settle(reservation.id, { outcome: 'failed', code: 'search_unavailable' }, refused('search_unavailable'));
      }
      return settle(reservation.id, { outcome: 'answered', bytes: searched.bytes,
        resultsCount: searched.answer.results.reduce((count, result) => count + result.items.length, 0) }, searched.answer);
    },

    // A look at who answers for a shared project: card() resolves the lead's
    // name and responsibility and the project's name as this computer knows
    // them, or { code } to refuse; recorded and counted like a search, and
    // cleaned like its results.
    async showSharedCard({ projectId, requester, card } = {}) {
      const reservation = reserve({ projectId, requester, action: 'card', asked: () => ({ queries: [] }) });
      if (reservation.code) return refused(reservation.code);
      let shown;
      try {
        const fields = await card();
        if (typeof fields?.code === 'string') {
          const code = plainCode(fields.code);
          return settle(reservation.id, { outcome: 'refused', code }, refused(code));
        }
        shown = sharedCard(fields ?? {});
      } catch {
        return settle(reservation.id, { outcome: 'failed', code: 'card_unavailable' }, refused('card_unavailable'));
      }
      return settle(reservation.id, { outcome: 'answered', bytes: shown.bytes, resultsCount: 1 }, shown.card);
    },

    // A visiting query this computer refused before it reached this port
    // (not shared, a wrong proof, a replay), once the asking device was
    // proven: recorded with its code and counted toward that device's limits.
    // projectId: the share's project when the host knows it, else none.
    recordRefusedVisit({ requester, action, code, projectId = null } = {}) {
      const who = requesterOf(requester);
      if (!who) return refused('requester_invalid');
      if (!ACTIONS.has(action) || typeof code !== 'string' || !PLAIN_CODE.test(code)) return refused('refusal_invalid');
      const project = searchableProject(projectId) ? projectId : '';
      try {
        store.transaction(() => store.recordRefusal({ ...who, projectId: project, action, code, at: now() }));
        return { ok: true };
      } catch {
        return refused(UNAVAILABLE);
      }
    },

    recentReads({ requesterKey = null, projectId = null, limit } = {}) {
      if (requesterKey !== null && !validKey(requesterKey)) return refused('requester_invalid');
      if (projectId !== null && !searchableProject(projectId)) return refused('project_invalid');
      try {
        return { ok: true, reads: store.recentReads({ requesterKey, projectId,
          limit: Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), READS_LIMIT) : READS_LIMIT }) };
      } catch {
        return refused(UNAVAILABLE);
      }
    },

    requesterMode(key) {
      if (!validKey(key)) return refused('requester_invalid');
      try { return { ok: true, mode: store.requester(key)?.mode ?? DEFAULT_MODE }; }
      catch { return refused(UNAVAILABLE); }
    },

    setRequesterMode({ key, kind, label, mode, ownDevice } = {}) {
      const shown = displayText(label);
      if (!validKey(key) || !['peer', 'guest'].includes(kind) || !key.startsWith(`${kind}:`) || !shown) {
        return refused('requester_invalid');
      }
      if (!MODES.has(mode)) return refused('mode_unknown');
      if (mode === 'trusted' && !(kind === 'peer' && ownDevice === true)) return refused('mode_not_allowed');
      try {
        return { ok: true, requester: store.setRequester({ key, kind, label: shown, mode,
          ownDevice: kind === 'peer' && ownDevice === true, at: now().toISOString() }) };
      } catch { return refused(UNAVAILABLE); }
    },

    // Guest links (deliverable B): created, listed and revoked by the person, opened by a bearer token.
    guestLinks: createGuestLinks({ store, now }),

    close: () => store.close()
  };

  // One attempt, checked and written in one transaction: past the requester's
  // limits, with an invalid project or with what asked() refuses, a 'refused'
  // row with its code; otherwise a 'pending' row the caller settles.
  function reserve({ projectId, requester, action, asked }) {
    const who = requesterOf(requester);
    if (!who) return { code: 'requester_invalid' };
    const at = now();
    const project = searchableProject(projectId) ? projectId : '';
    try {
      return store.transaction(() => {
        const question = asked();
        const code = rateLimitRefusal(store, who.requesterKey, project, at) ?? (project ? null : 'project_invalid')
          ?? question.code ?? null;
        if (code) {
          store.recordRefusal({ ...who, projectId: project, action, code, at });
          return { code };
        }
        return { id: store.reserveRead({ ...who, projectId: project, action, queries: question.queries, at }),
          projectId: project, queries: question.queries };
      });
    } catch {
      return { code: UNAVAILABLE };
    }
  }

  // A host's check, run after the reservation: a code, or null to go on; a check that throws refuses.
  async function confirmed(confirm) {
    try {
      const code = await confirm();
      return code === null ? null : plainCode(code);
    } catch { return 'confirm_failed'; }
  }

  // Finishes a reserved row, then answers; a row that cannot be finished is not
  // answered, so nothing leaves without its record.
  function settle(id, outcome, answer) {
    try {
      store.settleRead(id, outcome);
      return answer;
    } catch {
      return refused(UNAVAILABLE);
    }
  }
}

const ACTIONS = new Set(['search', 'card']);
const PLAIN_CODE = /^[a-z][a-z0-9_]{0,39}$/;
// One word for a store that cannot be used now.
const UNAVAILABLE = 'visitor_access_unavailable';
const plainCode = code => (typeof code === 'string' && PLAIN_CODE.test(code) ? code : 'refused');

const refused = code => ({ ok: false, code });
const validKey = key => typeof key === 'string' && REQUESTER_KEY.test(key);

// Display text without control or bidirectional characters, cut to
// MAX_LABEL_UNITS units before cleaning and LABEL_CHARS code points after;
// null when nothing readable is left.
function displayText(value) {
  if (typeof value !== 'string') return null;
  return [...withoutControls(value.slice(0, MAX_LABEL_UNITS))].slice(0, LABEL_CHARS).join('').trim() || null;
}

// The requester as recorded, or null only when its key cannot be used. A
// label with nothing readable becomes the start of the key; an agent name
// with nothing readable is left out.
function requesterOf(requester) {
  if (!validKey(requester?.key)) return null;
  return { requesterKey: requester.key, requesterLabel: displayText(requester.label) ?? requester.key.slice(0, LABEL_FALLBACK_CHARS),
    agentName: displayText(requester.agentName) };
}
const LABEL_FALLBACK_CHARS = 17;
