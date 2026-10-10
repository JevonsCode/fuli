import { readJson, sendJson } from '../http/response.js';
import { EmployeeError } from '../employees/manifest.js';

export async function handleJudgmentApiRequest({ request, response, url, app }) {
  if (!['/api/agent-pins', '/api/judgment/policy', '/api/judgment/records', '/api/judgment/feedback', '/api/judgment/review', '/api/judgment/assess', '/api/judgment/accept'].includes(url.pathname)) return false;
  if (!app.judgment) throw new EmployeeError('Judgment runtime unavailable', 503);
  const query = { personalSpaceId: url.searchParams.get('personalSpaceId'),
    ...(url.searchParams.has('personalProjectId') ? { personalProjectId: url.searchParams.get('personalProjectId') || null } : {}) };
  const actions = {
    'GET /api/agent-pins': () => app.judgment.pins({ personalSpaceId: query.personalSpaceId }),
    'PUT /api/agent-pins': async () => app.judgment.pin(await readJson(request)),
    'GET /api/judgment/policy': () => app.judgment.policy(query),
    'PUT /api/judgment/policy': async () => app.judgment.setPolicy(await readJson(request)),
    'GET /api/judgment/records': () => app.judgment.records(query),
    'POST /api/judgment/feedback': async () => app.judgment.feedback(await readJson(request)),
    'POST /api/judgment/review': async () => app.judgment.review(await readJson(request)),
    'POST /api/judgment/assess': async () => app.judgment.assess(await readJson(request)),
    'POST /api/judgment/accept': async () => app.judgment.accept(await readJson(request)),
  };
  const action = actions[`${request.method} ${url.pathname}`];
  if (!action) sendJson(response, 405, { error: 'Method not allowed' });
  else sendJson(response, 200, await action());
  return true;
}
