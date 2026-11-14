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

  // live and refuse are the listener's, for this request: live() tells whether
  // its link is still live, refuse() refuses this request as a revoked link.
  async function handle(request, response, { link, pathname, live, refuse }) {
    const recheck = () => live() || (refuse(), false);
    if (pathname === '/guest/1/mcp') {
      // A POST starts only once its body is in and its link is still live, and
      // its answer goes out only while it is.
      const admit = () => recheck() && (answerWhileLive(response, live, refuse), true);
      await mcpSessions.handle(request, response, { owner: link.id, admit, createMcp: () => createGuestMcp({ link, actions }) });
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

// The answer of one MCP POST (an event stream opened at once; a batch has
// several events) keeps its head until its first event or its end, and every
// event and the end go out only while live(). When the link ended before the
// head went out, the request gets refuse() (401); after, refuse() records it
// and the response is destroyed. Either way, also when a revoked link's
// session closes the stream, what follows is swallowed. A keep-alive comment
// while the head is held is dropped.
function answerWhileLive(response, live, refuse) {
  const { writeHead, write, end, flushHeaders } = response;
  let head = null;
  let state = 'held';
  const swallowed = () => true;
  const refused = () => {
    const held = state === 'held';
    state = 'refused';
    if (held) Object.assign(response, { writeHead, end, flushHeaders });
    refuse();
    Object.assign(response, { write: swallowed, end: () => response });
    if (!held) response.destroy();
  };
  // Whether what comes next may go out; sends the held head first.
  const goesOut = () => {
    if (state === 'refused') return false;
    if (!live()) {
      refused();
      return false;
    }
    if (state === 'held') {
      state = 'open';
      Object.assign(response, { writeHead, flushHeaders });
      if (head) writeHead.apply(response, head);
    }
    return true;
  };
  Object.assign(response, {
    writeHead: (...held) => { head = held; return response; },
    flushHeaders: () => {},
    write: (chunk, ...rest) => (state === 'held' && isComment(chunk)) || !goesOut() || write.call(response, chunk, ...rest),
    end: (...rest) => (goesOut() ? end.apply(response, rest) : response)
  });
}

const isComment = chunk => (typeof chunk === 'string' ? chunk.startsWith(':') : chunk?.[0] === 0x3a);

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
