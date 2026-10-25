import { PeerError } from './protocol.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The controls that change where this device's data can go: becoming a
// coordinator, inviting a device, joining one, and what is shared with it.
// Revoking a device and turning the roundtable off only narrow it.
const CHANGES = new Set(['POST /api/peer/coordinator', 'POST /api/peer/invitations', 'POST /api/peer/join', 'PUT /api/peer/shares']);

// The owner's LAN roundtable controls. They answer only on this computer's
// loopback address, even when the host's own server is reachable on the LAN.
// The host supplies its JSON body reader and writer, and may supply
// authorizeChange(request): its own check of the owner for a change (FULI's
// console session), called before the change's body is read; it throws to
// refuse, and its error goes to the host as it is.
export async function handlePeerControlRequest({ request, response, url, peer, readJson, sendJson, unavailableMessage,
  authorizeChange = () => {} }) {
  if (!url.pathname.startsWith('/api/peer')) return false;
  if (!peer) { sendJson(response, 404, { error: 'peer_unavailable', message: unavailableMessage }); return true; }
  const host = String(request.headers.host ?? '');
  if (!LOOPBACK.has(request.socket?.remoteAddress) || !/^(127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    sendJson(response, 403, { error: 'local_owner_only', message: 'LAN roundtable settings can only be changed on this computer' });
    return true;
  }
  if (CHANGES.has(`${request.method} ${url.pathname}`)) await authorizeChange(request);
  try {
    const result = await route(request, url.pathname, peer, readJson);
    if (result === undefined) return false;
    sendJson(response, 200, result);
  } catch (error) {
    if (!(error instanceof PeerError)) throw error;
    sendJson(response, error.status ?? 400, { error: error.code, message: error.message });
  }
  return true;
}

async function route(request, pathname, peer, readJson) {
  const { method } = request;
  if (pathname === '/api/peer' && method === 'GET') return peer.status();
  if (pathname === '/api/peer/coordinator' && method === 'POST') {
    const body = await readJson(request);
    return peer.enableCoordinator({ host: body.host, port: body.port ?? 0, name: body.name });
  }
  if (pathname === '/api/peer/invitations' && method === 'POST') { await readJson(request); return peer.createInvitation(); }
  if (pathname === '/api/peer/invitations/preview' && method === 'POST') {
    return peer.previewInvitation((await readJson(request)).invitation);
  }
  if (pathname === '/api/peer/join' && method === 'POST') {
    const body = await readJson(request);
    return peer.join({ invitation: body.invitation, name: body.name });
  }
  if (pathname === '/api/peer/shares' && method === 'PUT') return peer.setShares({ shares: (await readJson(request)).shares });
  const revoke = /^\/api\/peer\/devices\/([0-9a-f]{64})\/revoke$/.exec(pathname);
  if (revoke && method === 'POST') { await readJson(request); return peer.revokeDevice(revoke[1]); }
  if (pathname === '/api/peer/disable' && method === 'POST') { await readJson(request); return peer.disable(); }
  return undefined;
}
