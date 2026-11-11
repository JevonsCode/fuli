import { ApplicationError } from '../app/application-error.js';
import { sendJson } from './response.js';

// 整理 on the console (rec#114): how well a project is known and what the
// last runs did, for the card that says 「已了解 7 / 9」. Read only: a run
// records its own result (organize_project).
const PATH = '/api/project-organizing';

export async function handleProjectOrganizingRequest({ request, response, url, app }) {
  if (url.pathname !== PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!app.projectOrganizing) {
    sendJson(response, 503, { error: 'Organising a project needs a local FULI installation', code: 'project_organizing_unavailable' });
    return true;
  }
  if (url.searchParams.get('personalSpaceId') !== app.config.personal.spaceId) {
    throw new ApplicationError('scope_mismatch', 'Use the active personal space', { status: 403 });
  }
  const personalProjectId = url.searchParams.get('personalProjectId');
  if (!personalProjectId) throw new TypeError('personalProjectId is required');
  sendJson(response, 200, app.projectOrganizing.view(app.config.personal.spaceId, personalProjectId));
  return true;
}
