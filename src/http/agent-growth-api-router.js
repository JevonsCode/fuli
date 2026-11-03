import { sendJson } from './response.js';
import { nonEmptyText } from '../validation/values.js';

const GROWTH_PATH = /^\/api\/project-agents\/([^/]+)\/growth$/;

// What an FLA learned by doing, for the person to keep or drop (rec#78). A
// read through the console's owner port; nothing is written.
export async function handleAgentGrowthRequest({ request, response, url, app, ownerReads }) {
  const match = url.pathname.match(GROWTH_PATH);
  if (!match || request.method !== 'GET') return false;
  sendJson(response, 200, await app.getAgentGrowth({
    personalSpaceId: url.searchParams.get('personalSpaceId'),
    agentId: decodeURIComponent(match[1]),
    personalProjectId: nonEmptyText(url.searchParams.get('personalProjectId'))
  }, ownerReads));
  return true;
}
