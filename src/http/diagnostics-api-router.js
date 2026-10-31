import { ApplicationError } from '../app/application-error.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// The 诊断包 (src/system/diagnostics-bundle.js) the person previews on the
// settings page before exporting it. Its logs and paths are about this
// computer, so only a request from this computer, in the active personal
// space, reads it; no Agent tool reaches this route.

const DIAGNOSTICS_PATH = '/api/system/diagnostics';

export async function handleDiagnosticsApiRequest({ request, response, url, app, system }) {
  if (!system?.diagnostics || url.pathname !== DIAGNOSTICS_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'The diagnostics bundle is read only on this computer')) return true;
  if (url.searchParams.get('personalSpaceId') !== app.config.personal.spaceId) {
    throw new ApplicationError('scope_mismatch', 'Use the active personal space', { status: 403 });
  }
  sendJson(response, 200, await system.diagnostics());
  return true;
}
