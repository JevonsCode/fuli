import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// 访客链接 on a project page (rec issue 133, deliverable B). Every route
// answers on this computer only: a link's list names who may ask, and its
// token is shown once, at creation. Creating a link is the person's own
// decision (local_user_only); revoking only lowers exposure, so an FLA may do
// it for them (interface-catalog.js).
const LINKS_PATH = '/api/visitor-access/guest-links';
const LINK_PATH = /^\/api\/visitor-access\/guest-links\/([^/]+)$/;
const NOT_FOUND = new Set(['project_unknown', 'link_unknown']);

export async function handleGuestLinksRequest({ request, response, url, guestAccess }) {
  const link = LINK_PATH.exec(url.pathname);
  if (url.pathname !== LINKS_PATH && !link) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Guest links are managed only on this computer')) return true;
  if (!guestAccess) {
    sendJson(response, 503, { error: 'Guest links need a local FULI installation', code: 'guest_links_unavailable' });
    return true;
  }
  if (link && request.method === 'DELETE') {
    answer(response, await guestAccess.revoke(link[1]));
  } else if (!link && request.method === 'GET') {
    answer(response, guestAccess.list({ projectId: url.searchParams.get('projectId') }));
  } else if (!link && request.method === 'POST') {
    const body = await readJson(request);
    answer(response, await guestAccess.create({ projectId: body?.projectId, days: body?.days ?? undefined }), 201);
  } else {
    sendJson(response, 405, { error: 'Method not allowed' });
  }
  return true;
}

function answer(response, result, status = 200) {
  if (result.ok) {
    const { ok: _ok, ...body } = result;
    sendJson(response, status, body);
  } else {
    sendJson(response, NOT_FOUND.has(result.code) ? 404 : 400, { error: result.code, code: result.code });
  }
}
