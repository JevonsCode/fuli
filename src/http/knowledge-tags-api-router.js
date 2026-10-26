import { readJson, sendJson } from './response.js';
import { refuseRemoteDecision } from './request-policy.js';
import { nonEmptyText, positiveInteger } from '../validation/values.js';
import { applyTagGovernance, personKnowledgeTagChange, readTagsAcrossProjects } from '../graphiti/knowledge-tags.js';

const TAGS_PATH = /^\/api\/knowledge-tags(?:\/(metrics|vocabulary|detail|governance\/preview|governance))?$/;
const MAX_RESOLVE_LIMIT = 20;
const MAX_METRIC_DAYS = 366;
const MAX_VOCABULARY_PAGE = 200;
const MAX_VOCABULARY_OFFSET = 1_000_000;
const NAMESPACES = new Set(['personal', 'project']);
const STATUSES = new Set(['provisional', 'active', 'merged', 'retired', 'review']);

// The local console's tag vocabulary (rec#5 section 3, rec#11 D-07): reads
// across every project for the owner, governance previews, and the person's
// own changes. A change is accepted only on this computer and leaves on the
// human-review channel (src/knowledge-tags), so an Agent can link to the page
// but never post the change, not even straight to the Provider with its token.
export async function handleKnowledgeTagsRequest({ request, response, url, app, tagsConsole }) {
  const match = url.pathname.match(TAGS_PATH);
  if (!match) return false;
  const route = match[1] ?? '';
  const scope = { personalSpaceId: url.searchParams.get('personalSpaceId'),
    personalProjectId: nonEmptyText(url.searchParams.get('personalProjectId')) };
  if (request.method === 'GET') return read(route, { response, url, app, scope, tagsConsole });
  if (request.method !== 'POST' || !['', 'governance', 'governance/preview'].includes(route)) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (route === 'governance/preview') {
    if (!tagsConsole) return acrossProjectsUnavailable(response);
    sendJson(response, 200, await readTagsAcrossProjects(app, tagsConsole, 'governance_preview',
      await readJson(request)));
    return true;
  }
  if (refuseRemoteDecision(request, response, 'Tags are changed by the person only on this computer')) return true;
  if (!tagsConsole) {
    sendJson(response, 503, { error: 'Changing tags needs a local FULI installation' });
    return true;
  }
  const input = await readJson(request);
  sendJson(response, 200, route === 'governance'
    ? await applyTagGovernance(app, tagsConsole, input)
    : await personKnowledgeTagChange(app, tagsConsole, input));
  return true;
}

// The owner's reads across every project count every FLA's links, so they go
// on the console's human-review channel (readTagsAcrossProjects).
async function read(route, { response, url, app, scope, tagsConsole }) {
  const query = url.searchParams;
  const acrossProjects = route === 'vocabulary' || route === 'detail'
    || (route === 'metrics' && query.get('allProjects') === 'true');
  if (acrossProjects && !tagsConsole) return acrossProjectsUnavailable(response);
  if (route === 'metrics') {
    const input = { ...scope, ...numberParam(url, 'days', MAX_METRIC_DAYS) };
    sendJson(response, 200, acrossProjects ? await readTagsAcrossProjects(app, tagsConsole, 'metrics', input)
      : await app.knowledgeTags('metrics', { ...input, allProjects: false }));
  } else if (route === 'vocabulary') {
    sendJson(response, 200, await readTagsAcrossProjects(app, tagsConsole, 'vocabulary', { ...scope,
      query: nonEmptyText(query.get('q')), namespace: choice(query.get('namespace'), NAMESPACES, 'namespace'),
      status: choice(query.get('status'), STATUSES, 'status'), ...numberParam(url, 'limit', MAX_VOCABULARY_PAGE),
      ...(query.get('offset') && query.get('offset') !== '0'
        ? numberParam(url, 'offset', MAX_VOCABULARY_OFFSET) : {}) }));
  } else if (route === 'detail') {
    sendJson(response, 200, await readTagsAcrossProjects(app, tagsConsole, 'detail', { ...scope,
      tagId: query.get('tagId') }));
  } else if (route === '') {
    sendJson(response, 200, await app.knowledgeTags('resolve', { ...scope,
      query: query.get('q') ?? '', ...numberParam(url, 'limit', MAX_RESOLVE_LIMIT) }));
  } else {
    return false;
  }
  return true;
}

function acrossProjectsUnavailable(response) {
  sendJson(response, 503, { error: 'Reading tags across every project needs a local FULI installation' });
  return true;
}

function choice(value, allowed, name) {
  if (value === null || value === '') return undefined;
  if (!allowed.has(value)) throw new TypeError(`${name} is not one of ${[...allowed].join(', ')}`);
  return value;
}

function numberParam(url, name, maximum) {
  const value = url.searchParams.get(name);
  return value === null ? {} : { [name]: positiveInteger(Number(value), name, maximum) };
}
