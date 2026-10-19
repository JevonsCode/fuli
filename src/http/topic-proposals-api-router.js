import { readJson, sendJson } from './response.js';

// Astro's project suggestions for recurring unclaimed topics; the person decides.
export async function handleTopicProposalsRequest({ request, response, url, app }) {
  const action = url.pathname.match(/^\/api\/topic-proposals(?:\/(accept|decline))?$/);
  const operation = action && !action[1] && request.method === 'GET' ? 'list'
    : action?.[1] && request.method === 'POST' ? action[1] : null;
  if (!operation) return false;
  const input = operation === 'list'
    ? { personalSpaceId: url.searchParams.get('personalSpaceId') }
    : await readJson(request);
  sendJson(response, 200, await app.topicProposals(operation, input));
  return true;
}
