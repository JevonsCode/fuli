import { ApplicationError } from '../app/application-error.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

const LIST_PATH = '/api/agent-avatars';
const LOOK_PATH = /^\/api\/agent-avatars\/([^/]+)$/;
const IMAGE_PATH = /^\/api\/agent-avatars\/([^/]+)\/image$/;

// Each Agent's look as the person chose it (rec#11 D-89): the list of changed
// looks, one Agent's new look, and an uploaded picture by its version. The
// look is the person's choice on this computer; an Agent has no tool for it.
export async function handleAgentAvatarsRequest({ request, response, url, app }) {
  const look = url.pathname.match(LOOK_PATH);
  const image = url.pathname.match(IMAGE_PATH);
  const list = url.pathname === LIST_PATH && request.method === 'GET';
  if (!list && !(look && request.method === 'PUT') && !(image && request.method === 'GET')) return false;
  if (!app.agentAvatars) {
    sendJson(response, 503, { error: 'Agent looks need a local FULI installation', code: 'agent_avatars_unavailable' });
    return true;
  }
  const personalSpaceId = app.config.personal.spaceId;
  if (image) return sendImage(response, app.agentAvatars.image({ personalSpaceId, agentId: decodeURIComponent(image[1]) }));
  response.setHeader('Cache-Control', 'no-store');
  if (list) {
    if (url.searchParams.get('personalSpaceId') !== personalSpaceId) {
      throw new ApplicationError('scope_mismatch', 'Use the active personal space', { status: 403 });
    }
    sendJson(response, 200, app.agentAvatars.list(personalSpaceId));
    return true;
  }
  if (refuseRemoteDecision(request, response, 'An Agent\'s look is chosen only on this computer')) return true;
  const body = await readJson(request);
  if (body?.personalSpaceId !== personalSpaceId) {
    throw new ApplicationError('scope_mismatch', 'Use the active personal space', { status: 403 });
  }
  sendJson(response, 200, app.agentAvatars.set({ personalSpaceId, agentId: decodeURIComponent(look[1]), look: body.look }));
  return true;
}

// The URL carries the picture's version, so a changed picture is a new URL and
// one version can be kept by the browser; the type comes from the bytes.
function sendImage(response, picture) {
  if (!picture) {
    sendJson(response, 404, { error: 'This Agent shows no uploaded picture', code: 'agent_avatar_not_found' });
    return true;
  }
  response.writeHead(200, { 'content-type': picture.mediaType, 'content-length': picture.bytes.length,
    'cache-control': 'private, max-age=31536000, immutable', etag: `"${picture.version}"`,
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
  response.end(picture.bytes);
  return true;
}
