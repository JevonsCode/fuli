import { PeerError } from './protocol.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The owner's LAN roundtable controls. They answer only on this computer's
// loopback address, even when the host's own server is reachable on the LAN.
// The host supplies its JSON body reader and writer.
export async function handlePeerControlRequest({ request, response, url, peer, readJson, sendJson, unavailableMessage }) {
  if (!url.pathname.startsWith('/api/peer')) return false;
  if (!peer) { sendJson(response, 404, { error: 'peer_unavailable', message: unavailableMessage }); return true; }
  if (!isLocalOwnerRequest(request)) {
    sendJson(response, 403, { error: 'local_owner_only', message: 'LAN roundtable settings can only be changed on this computer' });
    return true;
  }
  try {
    const result = await route(request, url, peer, readJson);
    if (result === undefined) return false;
    sendJson(response, 200, result);
  } catch (error) {
    if (!(error instanceof PeerError)) throw error;
    // A refusal is always an error status, whatever another device answered.
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
    sendJson(response, status, { error: error.code, message: error.message });
  }
  return true;
}

// A request from this computer's own loopback address naming a loopback Host:
// what every owner-only LAN roundtable page answers, including who visited it.
export function isLocalOwnerRequest(request) {
  return LOOPBACK.has(request.socket?.remoteAddress)
    && /^(127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(request.headers?.host ?? ''));
}

async function route(request, url, peer, readJson) {
  const { method } = request;
  const { pathname } = url;
  if (pathname === '/api/peer' && method === 'GET') return peer.status();
  if (pathname === '/api/peer/shareable' && method === 'GET') {
    const limit = url.searchParams.get('limit');
    return peer.searchShareable({ query: url.searchParams.get('query') ?? '', ...(limit ? { limit: Number(limit) } : {}) });
  }
  const shareable = /^\/api\/peer\/shareable\/([^/]+)$/.exec(pathname);
  if (shareable && method === 'GET') return peer.shareableProject(projectIdOf(shareable[1]));
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
  if (pathname === '/api/peer/nearby' && method === 'POST') {
    const body = await readJson(request);
    if (typeof body.on !== 'boolean') throw new PeerError('invalid_nearby', 'Pass on: true or on: false', 422);
    return body.on ? peer.nearbyOn({ name: body.name }) : peer.nearbyOff();
  }
  if (pathname === '/api/peer/nearby/pair' && method === 'POST') return peer.pairNearby({ fingerprint: (await readJson(request)).fingerprint });
  if (pathname === '/api/peer/nearby/confirm' && method === 'POST') {
    const body = await readJson(request);
    return peer.confirmPairing({ requestId: body.requestId, code: body.code,
      ...(body.fingerprint === undefined ? {} : { fingerprint: body.fingerprint }) });
  }
  if (pathname === '/api/peer/nearby/cancel' && method === 'POST') { await readJson(request); return peer.cancelPairing(); }
  if (pathname === '/api/peer/nearby/attempts/clear' && method === 'POST') { await readJson(request); return peer.clearPairingAttempts(); }
  return undefined;
}

function projectIdOf(segment) {
  try { return decodeURIComponent(segment); }
  catch { throw new PeerError('project_not_found', 'No project of this computer can be shared under that id', 404); }
}
