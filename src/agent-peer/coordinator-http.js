import { createServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

import { derToPem, PEER_LIMITS, PeerError, sha256Hex } from './protocol.js';

const CLAIM_POLL_MS = 400;
const SWEEP_MS = 5_000;

// The only network listener of the LAN roundtable. Every route requires a
// TLS-verified, currently paired device, except one-use pairing, which accepts
// a not-yet-trusted client certificate and authorizes it by invitation code.
export async function startCoordinatorServer({ service, identity, host, port = 0, claimWaitMs = PEER_LIMITS.claimWaitMs }) {
  const secureContext = () => ({ ...identity.tlsOptions, ca: service.trustedCertificates() });
  const server = createServer({
    ...secureContext(), requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3',
    requestTimeout: claimWaitMs + 15_000, headersTimeout: 10_000, maxHeaderSize: 8192,
  }, (request, response) => {
    handle(request, response).catch((error) => send(response, error.status ?? 500,
      { error: error instanceof PeerError ? error.code : 'internal_error', message: error instanceof PeerError ? error.message : 'Request failed' }));
  });
  server.keepAliveTimeout = 5_000;

  async function handle(request, response) {
    const { pathname } = new URL(request.url, 'https://peer.invalid');
    if (request.method !== 'POST' || !pathname.startsWith('/peer/1/')) throw new PeerError('not_found', 'Not found', 404);
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new PeerError('unsupported_media_type', 'JSON required', 415);
    const certificate = request.socket.getPeerX509Certificate?.();
    if (!certificate) throw new PeerError('certificate_required', 'A device certificate is required', 401);
    const body = await readBody(request);
    if (pathname === '/peer/1/pair') {
      sendJson(response, service.pair({ code: body.code, name: body.name, authority: body.authority, certPem: derToPem(certificate.raw) }));
      return;
    }
    if (!request.socket.authorized) throw new PeerError('device_not_trusted', 'This device is not paired', 403);
    const nodeId = service.authenticate(sha256Hex(certificate.raw)).id;
    switch (pathname) {
      case '/peer/1/directory/publish': return sendJson(response, service.publishDirectory(nodeId, body));
      case '/peer/1/directory': return sendJson(response, service.directory(nodeId));
      case '/peer/1/messages': return sendJson(response, service.submit(nodeId, body));
      case '/peer/1/claim': return sendJson(response, { claim: await longPollClaim(nodeId, request, response) });
      case '/peer/1/renew': return sendJson(response, service.renew(nodeId, body));
      case '/peer/1/result': return sendJson(response, service.result(nodeId, body));
      case '/peer/1/status': return sendJson(response, service.status(nodeId, body));
      case '/peer/1/cancel': return sendJson(response, service.cancel(nodeId, body));
      case '/peer/1/leave': return sendJson(response, service.revoke(nodeId));
      default: throw new PeerError('not_found', 'Not found', 404);
    }
  }

  // Stops before claiming once the waiting runner is gone, so nothing is
  // handed to a closed connection.
  async function longPollClaim(nodeId, request, response) {
    const deadline = Date.now() + claimWaitMs;
    const gone = new AbortController();
    const markClosed = () => gone.abort();
    request.once('close', () => { if (!response.writableEnded) markClosed(); });
    response.once('close', markClosed);
    for (;;) {
      if (gone.signal.aborted || request.socket.destroyed) return null;
      service.authenticate(nodeId);
      const claimed = service.claim(nodeId);
      if (claimed || Date.now() >= deadline) return claimed;
      try { await delay(CLAIM_POLL_MS, undefined, { signal: gone.signal }); } catch { return null; }
    }
  }

  function sendJson(response, value) {
    send(response, 200, value);
  }

  const sweeper = setInterval(() => { try { service.sweep(); } catch { /* next sweep retries */ } }, SWEEP_MS);
  sweeper.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return {
    address: server.address(),
    // Trust changes apply to new connections; existing ones are re-checked per request.
    refreshTrust: () => server.setSecureContext(secureContext()),
    close: () => new Promise((resolve) => {
      clearInterval(sweeper);
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > PEER_LIMITS.requestBytes) {
        reject(new PeerError('payload_too_large', 'Request body is too large', 413));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (!size) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch { reject(new PeerError('invalid_json', 'Invalid JSON body')); }
    });
    request.on('error', reject);
  });
}

function send(response, status, value) {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body) });
  response.end(body);
}
