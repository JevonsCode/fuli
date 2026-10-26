import { readJson, sendJson } from '../http/response.js';
import { refuseRemoteDecision } from '../http/request-policy.js';
import { EmployeeError } from '../employees/manifest.js';
import { confirmConsoleOwner } from '../knowledge-owner-reads/owner-proof.js';
import { undoAutomaticReview } from './review-undo.js';
import { tonborgReviewSuggestions } from './review-suggestions.js';

const UNDO_PATH = '/api/judgment/undo';
const SUGGESTIONS_PATH = '/api/judgment/suggestions';
const PATHS = ['/api/agent-pins', '/api/judgment/policy', '/api/judgment/policies', '/api/judgment/records', '/api/judgment/feedback',
  '/api/judgment/review', '/api/judgment/assess', '/api/judgment/accept', UNDO_PATH, SUGGESTIONS_PATH];
// The routes that answer with Tonborg's full records (summary, evidence,
// receipts, feedback reasons) or its suggestions (rec#11 D-60): a judgment
// keeps an item's title and key from when Tonborg read it, the item may be
// one FLA's own since, and the model's words were written with Tonborg's
// scoped preferences, memory and earlier feedback. Like the console's other
// full reads, each is loopback only, a LAN device with its LAN code included,
// and answers only after the console server confirmed its own human-review
// proof (owner-proof.js), before anything is read, run or written. A refused
// request gets 403 and no data. The server attaches that proof itself and
// trusts local HTTP callers, so a local process can still read these routes
// over loopback. FULI is a local tool with no console login (rec#11 D-70).
// Agents read and ask Tonborg through their MCP tools (list_judgments,
// review_with_tonborg, assess_agent_action, assess_task_completion); no MCP
// or Agent tool module imports this one (test/judgment-console-owner.test.js).
// Pins and policy hold no history and stay readable as before.
const OWNER_ROUTES = new Set(['GET /api/judgment/records', 'POST /api/judgment/feedback', 'POST /api/judgment/review',
  'POST /api/judgment/assess', 'POST /api/judgment/accept', `GET ${SUGGESTIONS_PATH}`]);

// undoConsole: the human-review channel the person's undo is sent on
// (review-undo.js); ownerReads: the console's human-review read port
// (src/knowledge-owner-reads) that confirms the proof of an owner route.
// Both are null without a local installation.
export async function handleJudgmentApiRequest({ request, response, url, app, undoConsole = null, ownerReads = null }) {
  if (!PATHS.includes(url.pathname)) return false;
  if (!app.judgment) throw new EmployeeError('Judgment runtime unavailable', 503);
  const route = `${request.method} ${url.pathname}`;
  if (route === `POST ${UNDO_PATH}`) {
    response.setHeader('Cache-Control', 'no-store');
    if (refuseRemoteDecision(request, response, 'Undoing Tonborg\'s review is done only on this computer')) return true;
    if (!undoConsole) sendJson(response, 503, { error: 'Undoing Tonborg\'s review needs a local FULI installation' });
    else sendJson(response, 200, await undoAutomaticReview({ judgment: app.judgment, undoConsole, input: await readJson(request) }));
    return true;
  }
  if (OWNER_ROUTES.has(route)) {
    response.setHeader('Cache-Control', 'no-store');
    if (refuseRemoteDecision(request, response, 'Tonborg\'s judgments are read only on this computer')) return true;
    await confirmConsoleOwner(ownerReads, app.config?.personal?.spaceId, 'Tonborg\'s judgments');
  }
  const query = { personalSpaceId: url.searchParams.get('personalSpaceId'),
    ...(url.searchParams.has('personalProjectId') ? { personalProjectId: url.searchParams.get('personalProjectId') || null } : {}) };
  const actions = {
    'GET /api/agent-pins': () => app.judgment.pins({ personalSpaceId: query.personalSpaceId }),
    'PUT /api/agent-pins': async () => app.judgment.pin(await readJson(request)),
    'GET /api/judgment/policy': () => app.judgment.policy(query),
    'PUT /api/judgment/policy': async () => app.judgment.setPolicy(await readJson(request)),
    'GET /api/judgment/policies': () => app.judgment.policyOverrides({ personalSpaceId: query.personalSpaceId }),
    'GET /api/judgment/records': () => app.judgment.records({ ...query, ...recordPage(url.searchParams) }),
    'POST /api/judgment/feedback': async () => app.judgment.feedback(await readJson(request)),
    'POST /api/judgment/review': async () => app.judgment.review(await readJson(request)),
    'POST /api/judgment/assess': async () => app.judgment.assess(await readJson(request)),
    'POST /api/judgment/accept': async () => app.judgment.accept(await readJson(request)),
    [`GET ${SUGGESTIONS_PATH}`]: async () => ({ suggestions: await tonborgReviewSuggestions({ judgment: app.judgment,
      input: { personalSpaceId: query.personalSpaceId } }) }),
  };
  const action = actions[route];
  if (!action) sendJson(response, 405, { error: 'Method not allowed' });
  else sendJson(response, 200, await action());
  return true;
}

// The console's page of records: its size, the cursor after the previous
// page, the searched text and the 全部 / 需要人工 view.
function recordPage(params) {
  const page = params.has('limit') ? { limit: Number(params.get('limit')) } : {};
  for (const key of ['after', 'search', 'filter']) if (params.get(key)) page[key] = params.get(key);
  return page;
}
