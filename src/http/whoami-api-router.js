import { projectIdentity } from '../system/project-identity.js';
import { readJson, sendJson } from './response.js';

// `fuli whoami` (src/cli/whoami-command.js) and any other local process that
// needs to know which space and project a folder belongs to and which FLA leads
// it (rec#145). Read only: it changes nothing, enters no task and returns no
// token. A runner reaches it through its console entry's relay, which forwards
// a POST to a route neither blocked nor host-computer-only (console-relay.js),
// and sends the folder's facts with it because the folder is on the runner.
export async function handleWhoAmIRequest({ request, response, url, app }) {
  if (url.pathname !== '/api/whoami' || request.method !== 'POST') return false;
  const body = await readJson(request);
  sendJson(response, 200, await projectIdentity(app, {
    projectPath: typeof body?.projectPath === 'string' ? body.projectPath : null,
    personalProjectId: typeof body?.personalProjectId === 'string' ? body.personalProjectId : null,
    workspace: body?.workspace ?? null
  }));
  return true;
}
