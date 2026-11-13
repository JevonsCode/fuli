import { readJson, sendJson } from '../http/response.js';
import { guestCard } from './guest-card.js';

// The plain JSON routes a guest link opens, after the listener checked the
// source, the Host and the bearer token: the card and the scoped search of
// the link's one project. The search goes through the visitor-access port,
// which records every attempt (refused ones too) under 'guest:<link id>' and
// applies that requester's limits. A refusal names its reason in one plain
// word and never what exists on this computer.
const QUERY_REFUSALS = new Set(['queries_missing', 'too_many_queries', 'query_invalid']);
const RATE_REFUSALS = new Set(['rate_limited_short', 'rate_limited_day']);

export function createGuestRoutes({ visitorAccess, host }) {
  // The project's name and its lead as this computer knows them now; null when either cannot be read.
  const describeProject = projectId => Promise.all([host.getProject(projectId), host.projectTeam(projectId)])
    .then(([project, team]) => ({ name: project.name, lead: team.lead }), () => null);

  return async function handleGuestRoute(request, response, { link, pathname }) {
    if (pathname === '/guest/1/card') {
      if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
      const project = await describeProject(link.projectId);
      if (!project) return unavailable(response);
      sendJson(response, 200, guestCard({ project, link }));
      return true;
    }
    if (pathname === '/guest/1/search') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
      let body;
      try { body = await readJson(request); } catch { body = null; }
      const answer = await visitorAccess.searchSharedProject({ projectId: link.projectId, queries: body?.queries,
        requester: { key: `guest:${link.id}`, label: link.label } });
      if (answer.ok) sendJson(response, 200, { results: answer.results, truncated: answer.truncated });
      else if (QUERY_REFUSALS.has(answer.code)) sendJson(response, 400, { error: answer.code });
      else if (RATE_REFUSALS.has(answer.code)) sendJson(response, 429, { error: 'rate_limited' });
      else unavailable(response);
      return true;
    }
    return false;
  };
}

function methodNotAllowed(response, allow) {
  response.setHeader('allow', allow);
  sendJson(response, 405, { error: 'method_not_allowed' });
  return true;
}

function unavailable(response) {
  sendJson(response, 503, { error: 'unavailable' });
  return true;
}
