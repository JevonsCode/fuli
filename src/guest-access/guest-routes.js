import { readJson, sendJson } from '../http/response.js';
import { createHttpSessionTransport } from '../mcp/http-session-transport.js';
import { guestCard } from './guest-card.js';
import { createGuestMcp } from './guest-mcp.js';

// What a guest link opens, after the listener checked the source, the Host
// and the bearer token: the card and the scoped search of the link's one
// project, as plain JSON routes and as MCP tools at /guest/1/mcp (the same two
// actions). Both go through the visitor-access port (showSharedCard,
// searchSharedProject), which cleans them, records every attempt (refused
// ones too) under 'guest:<link id>' and applies that requester's and that
// project's limits. A refusal names its reason in one plain word and never
// what exists on this computer. Each MCP session belongs to the link that
// opened it; keepLinks ends the sessions of every link no longer live.
const QUERY_REFUSALS = new Set(['queries_missing', 'too_many_queries', 'query_invalid']);
const RATE_REFUSALS = new Set(['rate_limited_short', 'rate_limited_day', 'project_rate_limited_short', 'project_rate_limited_day']);
const MCP_MAX_SESSIONS = 16;
// One link holds at most this many, so one leaked link cannot take every session.
const MCP_SESSIONS_PER_LINK = 4;
const MCP_SESSION_IDLE_MS = 15 * 60 * 1000;
const MCP_SWEEP_MS = 30 * 1000;
const MCP_SHUTDOWN_GRACE_MS = 2000;

export function createGuestRoutes({ visitorAccess, host }) {
  const actions = guestActions({ visitorAccess, host });
  const mcpSessions = createHttpSessionTransport({ label: 'Guest MCP', maxSessions: MCP_MAX_SESSIONS,
    maxSessionsPerOwner: MCP_SESSIONS_PER_LINK,
    sessionIdleTtlMs: MCP_SESSION_IDLE_MS, sessionSweepIntervalMs: MCP_SWEEP_MS, now: Date.now });

  // recheck (the listener's) refuses the request and answers false once the link is no longer live.
  async function handle(request, response, { link, pathname, recheck }) {
    if (pathname === '/guest/1/mcp') {
      await mcpSessions.handle(request, response, { owner: link.id, admit: recheck,
        createMcp: () => createGuestMcp({ link, actions: liveActions(actions, recheck) }) });
      return true;
    }
    if (pathname === '/guest/1/card') {
      if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
      const { status, body } = await actions.card(link);
      if (recheck()) sendJson(response, status, body);
      return true;
    }
    if (pathname === '/guest/1/search') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
      let asked;
      try { asked = await readJson(request); } catch { asked = null; }
      if (!recheck()) return true;
      const { status, body } = await actions.search(link, asked?.queries);
      if (recheck()) sendJson(response, status, body);
      return true;
    }
    return false;
  }

  return {
    handle,
    keepLinks: liveIds => mcpSessions.closeOwnersExcept(new Set(liveIds)),
    close: () => mcpSessions.close(Date.now() + MCP_SHUTDOWN_GRACE_MS)
  };
}

// The card and the search of one link, each answered as { status, body }.
function guestActions({ visitorAccess, host }) {
  // The project's name and its lead as this computer knows them now, or a refusal when either cannot be read.
  const cardFields = projectId => Promise.all([host.getProject(projectId), host.projectTeam(projectId)])
    .then(([project, team]) => ({ name: team.lead?.name ?? '', responsibility: team.lead?.responsibility ?? '',
      projectName: project.name ?? '' }), () => ({ code: 'project_unavailable' }));
  const requester = link => ({ key: `guest:${link.id}`, label: link.label });

  return {
    async card(link) {
      const shown = await visitorAccess.showSharedCard({ projectId: link.projectId, requester: requester(link),
        card: () => cardFields(link.projectId) });
      return shown.ok ? { status: 200, body: guestCard({ shown, link }) } : refusal(shown.code);
    },
    async search(link, queries) {
      const answer = await visitorAccess.searchSharedProject({ projectId: link.projectId, queries, requester: requester(link) });
      return answer.ok ? { status: 200, body: { results: answer.results, truncated: answer.truncated } } : refusal(answer.code);
    }
  };
}

// The actions of one MCP session: an answer that is ready after its link
// ended is replaced by the refusal that link now gets. recheck is the one of
// the request that opened the session; any request of the session carries
// the same link's token.
function liveActions(actions, recheck) {
  const answered = answer => (recheck() ? answer : UNAUTHORIZED);
  return {
    card: async link => answered(await actions.card(link)),
    search: async (link, queries) => answered(await actions.search(link, queries))
  };
}

const UNAUTHORIZED = Object.freeze({ status: 401, body: Object.freeze({ error: 'unauthorized' }) });

// A refusal as a guest sees it: what they asked wrong, a limit, or one word for everything else.
function refusal(code) {
  if (QUERY_REFUSALS.has(code)) return { status: 400, body: { error: code } };
  if (RATE_REFUSALS.has(code)) return { status: 429, body: { error: 'rate_limited' } };
  return UNAVAILABLE;
}

const UNAVAILABLE = Object.freeze({ status: 503, body: Object.freeze({ error: 'unavailable' }) });

function methodNotAllowed(response, allow) {
  response.setHeader('allow', allow);
  sendJson(response, 405, { error: 'method_not_allowed' });
  return true;
}
