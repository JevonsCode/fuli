import { rateLimitRefusal } from './rate-limit.js';
import { searchSharedProject } from './shared-project-search.js';
import { VisitorAccessStore } from './store.js';

// The one port the visiting assistant reaches this computer's shared project
// knowledge through: a requester from another computer searches one project,
// read-only, rate limited and recorded; and the per-requester mode. Every
// refusal is { ok: false, code }; nothing a visitor sends reaches the search
// but the project id and the queries.
const MODES = new Set(['ask_only', 'plan', 'auto', 'trusted']);
const DEFAULT_MODE = 'plan';
const REQUESTER_KEY = /^(?:peer:[0-9a-f]{64}|guest:[A-Za-z0-9_-]{8,64})$/;
// The provider's personal project id: 1 to 128 characters; here also no
// surrounding space or control character.
const PROJECT_ID = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,126}[^\s\p{Cc}])?$/u;
const LABEL_CHARS = 120;
const READS_LIMIT = 200;

export function createVisitorAccess({ path = ':memory:', application, now = () => new Date() }) {
  const store = new VisitorAccessStore(path);

  return {
    async searchSharedProject({ projectId, requester, queries }) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return refused('project_invalid');
      if (!validRequester(requester)) return refused('requester_invalid');
      const at = now();
      const limited = rateLimitRefusal(store, requester.key, at);
      if (limited) return refused(limited);
      let searched;
      try {
        searched = await searchSharedProject(application, { projectId, queries });
      } catch {
        return refused('search_unavailable');
      }
      if (searched.code) return refused(searched.code);
      store.recordRead({ requesterKey: requester.key, requesterLabel: requester.label,
        agentName: requester.agentName ?? null, projectId, action: 'search', queries: searched.queries,
        resultsCount: searched.answer.results.reduce((count, result) => count + result.items.length, 0),
        bytes: searched.bytes, at });
      return { ok: true, ...searched.answer };
    },

    recentReads({ requesterKey = null, projectId = null, limit }) {
      return store.recentReads({ requesterKey, projectId,
        limit: Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), READS_LIMIT) : READS_LIMIT });
    },

    requesterMode(key) {
      return store.requester(key)?.mode ?? DEFAULT_MODE;
    },

    setRequesterMode({ key, kind, label, mode, ownDevice }) {
      if (!REQUESTER_KEY.test(String(key)) || !key.startsWith(`${kind}:`) || !validLabel(label)) {
        return refused('requester_invalid');
      }
      if (!MODES.has(mode)) return refused('mode_unknown');
      if (mode === 'trusted' && !(kind === 'peer' && ownDevice === true)) return refused('mode_not_allowed');
      return { ok: true, requester: store.setRequester({ key, kind, label, mode,
        ownDevice: kind === 'peer' && ownDevice === true, at: now().toISOString() }) };
    },

    close: () => store.close()
  };
}

const refused = code => ({ ok: false, code });

const validLabel = label => typeof label === 'string' && label.trim().length > 0 && label.length <= LABEL_CHARS;

function validRequester(requester) {
  return typeof requester?.key === 'string' && REQUESTER_KEY.test(requester.key) && validLabel(requester.label)
    && (requester.agentName === undefined || requester.agentName === null || validLabel(requester.agentName));
}
