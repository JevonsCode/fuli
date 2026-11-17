import { createServer as createHttpsServer } from 'node:https';

import { sendJson } from '../http/response.js';
import { sha256Bytes } from '../security/digest.js';
import { createAddressListeners } from '../server/address-listeners.js';
import { isGuestSourceAddress } from '../server/lan-access.js';

// The host's runner listener (docs/runner.md): TLS 1.3 on this computer's
// private network addresses, apart from the console, following them as they
// change. Every connection presents a device certificate; a request reaches its
// route only from a private address, under /runner/1/, with the SHA-256
// fingerprint of that certificate. Whether the fingerprint belongs to a paired
// runner is the route's to decide: only pairing accepts one that does not yet.
const RUNNER_PREFIX = '/runner/1/';
const HEADERS_TIMEOUT_MS = 10_000;
// An MCP call may wait on the graph; a stream stays open while it answers.
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 64;
const MAX_HEADERS_COUNT = 50;

export async function startRunnerListener({ identity, addresses, port, route, sourceAllowed = isGuestSourceAddress,
  createServer = createHttpsServer }) {
  const tls = { ...identity.tlsOptions, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' };
  const handler = (request, response) => {
    response.setHeader('cache-control', 'no-store');
    handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
      else if (!response.writableEnded) response.destroy();
    });
  };

  async function handle(request, response) {
    const plain = (address) => String(address ?? '').replace(/^::ffff:/i, '');
    const source = plain(request.socket?.remoteAddress);
    if (!sourceAllowed(source, plain(request.socket?.localAddress)) || request.headers.origin !== undefined) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    const fingerprint = peerFingerprint(request.socket);
    if (!fingerprint) {
      sendJson(response, 401, { error: 'device_certificate_required' });
      return;
    }
    const { pathname } = new URL(request.url ?? '/', 'https://runner.invalid');
    if (!pathname.startsWith(RUNNER_PREFIX) || !await route(request, response, { fingerprint, pathname, address: source })) {
      sendJson(response, 404, { error: 'not_found' });
    }
  }

  const listeners = createAddressListeners({ port, createServer: () => runnerServer(createServer, tls, handler) });
  await listeners.rebind(addresses);
  return {
    get port() { return listeners.port; },
    get addresses() { return listeners.addresses; },
    rebind: listeners.rebind,
    close: listeners.close
  };
}

// The fingerprint of the certificate the other end presented, as the LAN
// roundtable computes it (SHA-256 of the DER), or null without one.
function peerFingerprint(socket) {
  const raw = socket?.getPeerCertificate?.()?.raw;
  return Buffer.isBuffer(raw) && raw.length ? sha256Bytes(raw) : null;
}

function runnerServer(createServer, tls, handler) {
  const server = createServer(tls, handler);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.on('error', () => {});
  server.on('tlsClientError', () => {});
  return server;
}
