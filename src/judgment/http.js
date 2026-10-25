import { readJson, sendJson } from '../http/response.js';
import { refuseRemoteDecision } from '../http/request-policy.js';
import { EmployeeError } from '../employees/manifest.js';
import { undoAutomaticReview } from './review-undo.js';
import { tonborgReviewSuggestions } from './review-suggestions.js';

const UNDO_PATH = '/api/judgment/undo';
// The console's read of Tonborg's knowledge review suggestions (review-suggestions.js); GET only.
const SUGGESTIONS_PATH = '/api/judgment/suggestions';

// undoConsole: the human-review channel the person's undo is sent on
// (review-undo.js); null without a local installation.
export async function handleJudgmentApiRequest({ request, response, url, app, undoConsole = null }) {
  if (!['/api/agent-pins', '/api/judgment/policy', '/api/judgment/records', '/api/judgment/feedback', '/api/judgment/review', '/api/judgment/assess', '/api/judgment/accept', UNDO_PATH, SUGGESTIONS_PATH].includes(url.pathname)) return false;
  if (!app.judgment) throw new EmployeeError('Judgment runtime unavailable', 503);
  if (url.pathname === UNDO_PATH && request.method === 'POST') {
    response.setHeader('Cache-Control', 'no-store');
    if (refuseRemoteDecision(request, response, 'Undoing Tonborg\'s review is done only on this computer')) return true;
    if (!undoConsole) sendJson(response, 503, { error: 'Undoing Tonborg\'s review needs a local FULI installation' });
    else sendJson(response, 200, await undoAutomaticReview({ judgment: app.judgment, undoConsole, input: await readJson(request) }));
    return true;
  }
  if (url.pathname === SUGGESTIONS_PATH) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') sendJson(response, 405, { error: 'Method not allowed' });
    else sendJson(response, 200, { suggestions: await tonborgReviewSuggestions({ judgment: app.judgment,
      input: { personalSpaceId: url.searchParams.get('personalSpaceId') } }) });
    return true;
  }
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
