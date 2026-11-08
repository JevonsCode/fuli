import { InvalidInputError } from '../app/application-error.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// The desktop app's own fl and fuli in a terminal (src/desktop/cli-path.js):
// whether they are on, and the person's switch in Settings › 客户端. Turning
// them on or off edits the person's shell profile or user PATH, so only a
// request from this computer does it.

const CLI_PATH = '/api/system/cli-path';

export async function handleCliPathRequest({ request, response, url, system }) {
  if (url.pathname !== CLI_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  const control = system?.cliPath ?? null;
  if (!['GET', 'PUT'].includes(request.method)) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (request.method === 'GET') {
    sendJson(response, 200, control ? control.status() : { supported: false, enabled: false });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'The terminal commands are changed only on this computer')) return true;
  if (!control) {
    sendJson(response, 404, { error: 'Only the desktop app puts its commands on PATH', code: 'cli_path_unavailable' });
    return true;
  }
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'enabled' || typeof body.enabled !== 'boolean') {
    throw new InvalidInputError('Send only enabled: true or false.');
  }
  sendJson(response, 200, control.set(body.enabled));
  return true;
}
