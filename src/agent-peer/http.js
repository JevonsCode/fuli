import { readJson, sendJson } from '../http/response.js';
import { PeerError } from './protocol.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The owner's LAN roundtable controls. They answer only on this computer's
// loopback console, even when the console itself is reachable on the LAN.
export async function handlePeerApiRequest({ request, response, url, peer }) {
  if (!url.pathname.startsWith('/api/peer')) return false;
  if (!peer) { sendJson(response, 404, { error: 'peer_unavailable', message: 'The LAN roundtable needs a local FULI installation' }); return true; }
  const host = String(request.headers.host ?? '');
  if (!LOOPBACK.has(request.socket?.remoteAddress) || !/^(127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    sendJson(response, 403, { error: 'local_owner_only', message: 'LAN roundtable settings can only be changed on this computer' });
    return true;
  }
  try {
    const result = await route(request, url.pathname, peer);
    if (result === undefined) return false;
    sendJson(response, 200, result);
  } catch (error) {
    if (!(error instanceof PeerError)) throw error;
    sendJson(response, error.status ?? 400, { error: error.code, message: error.message });
  }
  return true;
}

async function route(request, pathname, peer) {
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
