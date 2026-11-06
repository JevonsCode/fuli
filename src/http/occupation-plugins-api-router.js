import { readJson, sendJson } from './response.js';
import { OCCUPATION_KIT_HANDLERS } from '../occupation-plugins/agent-tools.js';
import { nonEmptyText, requiredString } from '../validation/values.js';

const KIT_PATH = /^\/api\/project-agents\/([^/]+)\/occupation-kit$/;
const ID_MAX_CHARS = 128;

// Occupation plugins (docs/occupation-plugins.md): the occupations page reads
// every plugin with its source and license and checks for, applies and
// switches daily updates of the manifest; an FLA's page reads its kit and
// saves the person's answer to which recommendations it uses.
export async function handleOccupationPluginsRequest({ request, response, url, app }) {
  const plugins = app.occupationPlugins;
  if (!plugins) return false;
  const route = `${request.method} ${url.pathname}`;
  const kit = url.pathname.match(KIT_PATH);
  if (route === 'GET /api/occupation-plugins') {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, plugins.list());
  } else if (route === 'POST /api/occupation-plugins/check') {
    sendJson(response, 200, await plugins.check());
  } else if (route === 'POST /api/occupation-plugins/apply') {
    const { digest } = await readJson(request);
    sendJson(response, 200, plugins.apply(requiredString(digest, 'digest', ID_MAX_CHARS)));
  } else if (route === 'PUT /api/occupation-plugins/auto-update') {
    sendJson(response, 200, plugins.setAutoUpdate((await readJson(request)).enabled));
  } else if (kit && request.method === 'GET') {
    sendJson(response, 200, await OCCUPATION_KIT_HANDLERS.read_occupation_kit(app, {
      personalSpaceId: url.searchParams.get('personalSpaceId'), agentId: decodeURIComponent(kit[1]),
      personalProjectId: nonEmptyText(url.searchParams.get('personalProjectId'))
    }));
  } else if (kit && request.method === 'PUT') {
    const body = await readJson(request);
    const personalSpaceId = requiredString(body.personalSpaceId, 'personalSpaceId', ID_MAX_CHARS);
    const agentId = decodeURIComponent(kit[1]);
    const { occupation } = await OCCUPATION_KIT_HANDLERS.read_occupation_kit(app, { personalSpaceId, agentId });
    sendJson(response, 200, plugins.choose({ personalSpaceId, agentId, occupation,
      skills: body.skills, mcpServers: body.mcpServers, answeredBy: 'person' }));
  } else {
    return false;
  }
  return true;
}
