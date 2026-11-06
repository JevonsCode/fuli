import { InvalidInputError } from '../app/application-error.js';
import { termsReadiness } from '../retrieval-terms/terms-model.js';
import { requiredString } from '../validation/values.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// Retrieval terms for old knowledge on the model page (rec#92). GET counts
// what lacks terms and shows the last self-test and fill of a project; POST
// trial runs the self-test, fill starts the fill, stop stops it. Only from this
// computer: each sends the project's knowledge to the person's own model.
const PATH = '/api/retrieval-terms';
const ACTIONS = new Set(['trial', 'fill', 'stop']);

export async function handleRetrievalTermsRequest({ request, response, url, app, runner }) {
  const action = url.pathname.startsWith(`${PATH}/`) ? url.pathname.slice(PATH.length + 1) : null;
  if (url.pathname !== PATH && !ACTIONS.has(action)) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Retrieval terms are made only on this computer')) return true;
  if (!runner) { sendJson(response, 503, { error: 'Retrieval terms need a local FULI installation', code: 'retrieval_terms_unavailable' }); return true; }
  if (!action) {
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
    const projectId = requiredString(url.searchParams.get('projectId'), 'projectId', 128);
    sendJson(response, 200, { readiness: termsReadiness(app, projectId), ...await runner.status(projectId) });
    return true;
  }
  if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
  if (action === 'stop') { await runner.stop(); sendJson(response, 200, { stopped: true }); return true; }
  const body = await readJson(request);
  if (!body || typeof body !== 'object') throw new InvalidInputError('A project is required');
  const personalProjectId = requiredString(body.personalProjectId, 'personalProjectId', 128);
  if (action === 'trial') { sendJson(response, 200, await runner.trial(personalProjectId)); return true; }
  const readiness = termsReadiness(app, personalProjectId);
  if (readiness !== 'ready') { sendJson(response, 409, { error: 'A model must be connected and this project approved', code: readiness }); return true; }
  const run = runner.fill(personalProjectId);
  sendJson(response, run.status === 'busy' ? 409 : 202, run);
  return true;
}
