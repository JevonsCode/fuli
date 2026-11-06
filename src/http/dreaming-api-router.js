import { InvalidInputError } from '../app/application-error.js';
import { dreamingProjects } from '../dreaming/projects.js';
import { dreamProject } from '../dreaming/run.js';
import { dreamingRuns, dreamingSince } from '../dreaming/scheduler.js';
import { requiredString } from '../validation/values.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// Dreaming on the model page (rec#89): GET lists each project with how many
// sessions its next run would read and what its last run found; POST runs one
// project now, from the last complete run or, with fromStart, from the
// beginning. Only from this computer: a run sends the project's sessions to the
// person's own model.
const PATH = '/api/dreaming';
const RUN_PATH = '/api/dreaming/run';

export async function handleDreamingRequest({ request, response, url, app, ownerReads }) {
  if (url.pathname !== PATH && url.pathname !== RUN_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Dreaming runs only on this computer')) return true;
  if (url.pathname === PATH) {
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
    sendJson(response, 200, await dreamingProjects(app));
    return true;
  }
  if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
  if (!ownerReads) { sendJson(response, 503, { error: 'Dreaming needs a local FULI installation', code: 'dreaming_unavailable' }); return true; }
  const body = await readJson(request);
  if (!body || typeof body !== 'object') throw new InvalidInputError('A project is required');
  const personalProjectId = requiredString(body.personalProjectId, 'personalProjectId', 128);
  if (body.fromStart !== undefined && typeof body.fromStart !== 'boolean') throw new InvalidInputError('fromStart must be true or false');
  const since = body.fromStart ? null : dreamingSince(await dreamingRuns(app), personalProjectId);
  sendJson(response, 200, await dreamProject(app, ownerReads, { personalProjectId, since }));
  return true;
}
