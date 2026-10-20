import { readJson, sendJson } from './response.js';
import { nonEmptyText, positiveInteger } from '../validation/values.js';
import { knowledgeTagChange } from '../graphiti/knowledge-tags.js';

const TAGS_PATH = /^\/api\/knowledge-tags(\/metrics)?$/;
const MAX_RESOLVE_LIMIT = 20;
const MAX_METRIC_DAYS = 366;

// The local console's tag vocabulary: reads, and the person's own changes.
export async function handleKnowledgeTagsRequest({ request, response, url, app }) {
  const match = url.pathname.match(TAGS_PATH);
  if (!match) return false;
  const scope = { personalSpaceId: url.searchParams.get('personalSpaceId'),
    personalProjectId: nonEmptyText(url.searchParams.get('personalProjectId')) };
  if (request.method === 'GET' && match[1]) {
    sendJson(response, 200, await app.knowledgeTags('metrics', { ...scope,
      allProjects: url.searchParams.get('allProjects') === 'true',
      ...numberParam(url, 'days', MAX_METRIC_DAYS) }));
    return true;
  }
  if (request.method === 'GET') {
    sendJson(response, 200, await app.knowledgeTags('resolve', { ...scope,
      query: url.searchParams.get('q') ?? '', ...numberParam(url, 'limit', MAX_RESOLVE_LIMIT) }));
    return true;
  }
  if (request.method !== 'POST' || match[1]) return false;
  const input = await readJson(request);
  sendJson(response, 200, await app.knowledgeTags(knowledgeTagChange(input.action),
    { ...input, operationActor: 'human' }));
  return true;
}

function numberParam(url, name, maximum) {
  const value = url.searchParams.get(name);
  return value === null ? {} : { [name]: positiveInteger(Number(value), name, maximum) };
}
