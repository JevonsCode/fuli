import { readJson, sendJson } from './response.js';
import { refuseRemoteDecision } from './request-policy.js';
import { validationError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';

const PARENT_PATH = /^\/api\/personal-projects\/([^/]+)\/parent$/;
const MAX_PROJECT_ID = 128;
// The Provider keeps a reason with every hierarchy review event.
const MOVE_REASON = 'Moved by the person in the console projects view.';

// A person's move of a project under another one, or to the top level, from
// the projects view. Accepted only on this computer and sent on the
// human-review channel (src/project-hierarchy), so an Agent can never post it,
// not even straight to the Provider with its own token. No Agent tool reaches
// this route.
export async function handleProjectHierarchyRequest({ request, response, url, app, hierarchyConsole }) {
  const match = url.pathname.match(PARENT_PATH);
  if (!match || request.method !== 'POST') return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Projects are moved only on this computer')) return true;
  if (!hierarchyConsole) {
    sendJson(response, 503, { error: 'Moving a project needs a local FULI installation' });
    return true;
  }
  const body = await readJson(request);
  if (body?.personalSpaceId !== app.config.personal.spaceId) {
    throw validationError('Projects are moved in the active personal space');
  }
  const projectId = requiredString(decodeURIComponent(match[1]), 'projectId', MAX_PROJECT_ID);
  const parent = body.parentProjectId === null
    ? null
    : requiredString(body.parentProjectId, 'parentProjectId', MAX_PROJECT_ID);
  sendJson(response, 200, await hierarchyConsole.moveProject(body.personalSpaceId, projectId,
    { parent_project_id: parent, reason: MOVE_REASON }));
  return true;
}
