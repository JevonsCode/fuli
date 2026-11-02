import { ApplicationError } from '../app/application-error.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// The 诊断包 (src/system/diagnostics-bundle.js) the person previews on the
// settings page before exporting it, and the kept copies of FULI's logs the
// person clears there (「清理旧日志」, log-retention.js). Their logs and paths
// are about this computer, so only a request from this computer, in the active
// personal space, reaches them; no Agent tool reaches these routes.

const DIAGNOSTICS_PATH = '/api/system/diagnostics';
const LOG_ARCHIVES_PATH = '/api/system/log-archives';

export async function handleDiagnosticsApiRequest({ request, response, url, app, system }) {
  const route = url.pathname === DIAGNOSTICS_PATH && system?.diagnostics ? { GET: () => system.diagnostics() }
    : url.pathname === LOG_ARCHIVES_PATH && system?.logArchives
      ? { GET: () => system.logArchives(), DELETE: () => system.clearLogArchives() } : null;
  if (!route) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (!route[request.method]) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'FULI\'s diagnostics and logs are read only on this computer')) return true;
  if (url.searchParams.get('personalSpaceId') !== app.config.personal.spaceId) {
    throw new ApplicationError('scope_mismatch', 'Use the active personal space', { status: 403 });
  }
  sendJson(response, 200, await route[request.method]());
  return true;
}
