import { ApplicationError } from '../app/application-error.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson, sendPortrait } from './response.js';

// The person's own home (「我」, person-profile/port.js): what FULI calls them
// and their picture. Both are about the person at this computer, so only a
// request from this computer, in the active personal space, reads or changes
// them; no Agent tool reaches these routes, and an FLA changes them only by
// relaying the person's words (agent_relayed, rec#80). Agents read only the
// name, from the preferences of their task entry.

const PROFILE_PATH = '/api/person-profile';
const IMAGE_PATH = '/api/person-profile/image';

export async function handlePersonProfileRequest({ request, response, url, app }) {
  const route = url.pathname === PROFILE_PATH ? ['GET', 'PUT'] : url.pathname === IMAGE_PATH ? ['GET'] : null;
  if (!route) return false;
  if (!app.personProfile) {
    sendJson(response, 503, { error: 'Your home needs a local FULI installation', code: 'person_profile_unavailable' });
    return true;
  }
  if (!route.includes(request.method)) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'Your name and picture are kept and changed only on this computer')) return true;
  const body = request.method === 'PUT' ? await readJson(request) : null;
  const personalSpaceId = body ? body.personalSpaceId : url.searchParams.get('personalSpaceId');
  if (personalSpaceId !== app.config.personal.spaceId) {
    throw new ApplicationError('scope_mismatch', 'Use the active personal space', { status: 403 });
  }
  if (url.pathname === IMAGE_PATH) {
    sendPortrait(response, app.personProfile.image(), { error: 'You show no uploaded picture', code: 'person_picture_not_found' });
    return true;
  }
  response.setHeader('Cache-Control', 'no-store');
  sendJson(response, 200, body ? app.personProfile.update({ name: body.name, look: body.look }) : app.personProfile.view());
  return true;
}
