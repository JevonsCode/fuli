import { readJson, sendJson } from '../http/response.js';
import { createHttpSessionTransport } from '../mcp/http-session-transport.js';
import { guestCard } from './guest-card.js';
import { createGuestMcp } from './guest-mcp.js';

// What a guest link opens, after the listener checked the source, the Host
// and the bearer token: the card and the scoped search of the link's one
// project, as plain JSON routes and as MCP tools at /guest/1/mcp (the same two
// actions). The search goes through the visitor-access port, which records
// every attempt (refused ones too) under 'guest:<link id>' and applies that
// requester's limits. A refusal names its reason in one plain word and never
// what exists on this computer. Each MCP session belongs to the link that
// opened it; closeLink ends a revoked link's sessions at once.
const QUERY_REFUSALS = new Set(['queries_missing', 'too_many_queries', 'query_invalid']);
const RATE_REFUSALS = new Set(['rate_limited_short', 'rate_limited_day']);
const MCP_MAX_SESSIONS = 16;
const MCP_SESSION_IDLE_MS = 15 * 60 * 1000;
const MCP_SWEEP_MS = 30 * 1000;
const MCP_SHUTDOWN_GRACE_MS = 2000;

export function createGuestRoutes({ visitorAccess, host }) {
  const actions = guestActions({ visitorAccess, host });
  const mcpSessions = createHttpSessionTransport({ label: 'Guest MCP', maxSessions: MCP_MAX_SESSIONS,
    sessionIdleTtlMs: MCP_SESSION_IDLE_MS, sessionSweepIntervalMs: MCP_SWEEP_MS, now: Date.now });

  async function handle(request, response, { link, pathname }) {
    if (pathname === '/guest/1/mcp') {
      await mcpSessions.handle(request, response, { owner: link.id, createMcp: () => createGuestMcp({ link, actions }) });
      return true;
    }
    if (pathname === '/guest/1/card') {
      if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
      const { status, body } = await actions.card(link);
      sendJson(response, status, body);
      return true;
    }
    if (pathname === '/guest/1/search') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
      let asked;
      try { asked = await readJson(request); } catch { asked = null; }
      const { status, body } = await actions.search(link, asked?.queries);
      sendJson(response, status, body);
      return true;
    }
    return false;
  }

  return {
    handle,
    closeLink: linkId => mcpSessions.closeOwner(linkId),
    close: () => mcpSessions.close(Date.now() + MCP_SHUTDOWN_GRACE_MS)
  };
}

// The card and the search of one link, each answered as { status, body }.
function guestActions({ visitorAccess, host }) {
  // The project's name and its lead as this computer knows them now; null when either cannot be read.
  const describeProject = projectId => Promise.all([host.getProject(projectId), host.projectTeam(projectId)])
    .then(([project, team]) => ({ name: project.name, lead: team.lead }), () => null);

  return {
    async card(link) {
      const project = await describeProject(link.projectId);
      return project ? { status: 200, body: guestCard({ project, link }) } : UNAVAILABLE;
    },
    async search(link, queries) {
      const answer = await visitorAccess.searchSharedProject({ projectId: link.projectId, queries,
        requester: { key: `guest:${link.id}`, label: link.label } });
      if (answer.ok) return { status: 200, body: { results: answer.results, truncated: answer.truncated } };
      if (QUERY_REFUSALS.has(answer.code)) return { status: 400, body: { error: answer.code } };
      if (RATE_REFUSALS.has(answer.code)) return { status: 429, body: { error: 'rate_limited' } };
      return UNAVAILABLE;
    }
  };
}

const UNAVAILABLE = Object.freeze({ status: 503, body: Object.freeze({ error: 'unavailable' }) });

function methodNotAllowed(response, allow) {
  response.setHeader('allow', allow);
  sendJson(response, 405, { error: 'method_not_allowed' });
  return true;
}
