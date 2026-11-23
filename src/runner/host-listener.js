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
// Connections of every address together: a backstop, counted here because the
// listener binds one server per address and node's own maxConnections is per
// server. It leaves room for the 64 MCP sessions the routes allow in all
// (host-routes.js), each of whose processes keeps a few (a request socket and
// its event stream). A connection that does not finish its TLS handshake in
// HANDSHAKE_TIMEOUT_MS is closed.
const MAX_CONNECTIONS = 256;
// Any device on the network can finish a TLS handshake here: the certificate
// it presents is the route's to judge, not the socket's. So a source that has
// not shown a paired runner's certificate gets a share of its own, and one
// device cannot hold every connection and keep the paired runners out. It is
// far more than pairing or a runner's own processes need from one address.
const MAX_UNPAIRED_PER_SOURCE = 24;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HEADERS_COUNT = 50;

// isPairedDevice(fingerprint): whether that certificate is a runner this host
// knows. A connection is counted against its source's share until it shows one.
export async function startRunnerListener({ identity, addresses, port, route, sourceAllowed = isGuestSourceAddress,
  isPairedDevice = () => false, createServer = createHttpsServer }) {
  const tls = { ...identity.tlsOptions, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3',
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS };
  const handler = (request, response) => {
    response.setHeader('cache-control', 'no-store');
    handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
      else if (!response.writableEnded) response.destroy();
    });
  };

  async function handle(request, response) {
    const source = plainAddress(request.socket?.remoteAddress);
    if (!sourceAllowed(source, plainAddress(request.socket?.localAddress)) || request.headers.origin !== undefined) {
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

  const connections = openConnections({ isPairedDevice });
  const listeners = createAddressListeners({ port, createServer: () => runnerServer(createServer, tls, handler, connections) });
  await listeners.rebind(addresses);
  return {
    get port() { return listeners.port; },
    get addresses() { return listeners.addresses; },
    rebind: listeners.rebind,
    close: listeners.close
  };
}

// An address as the person's own networks name it, without IPv4-in-IPv6.
function plainAddress(address) {
  return String(address ?? '').replace(/^::ffff:/i, '');
}

// The fingerprint of the certificate the other end presented, as the LAN
// roundtable computes it (SHA-256 of the DER), or null without one.
function peerFingerprint(socket) {
  const raw = socket?.getPeerCertificate?.()?.raw;
  return Buffer.isBuffer(raw) && raw.length ? sha256Bytes(raw) : null;
}

// What the servers of every address hold together: the total over all of them,
// and each source address's share of the connections held by a device that has
// not shown a paired runner's certificate. A paired runner's connection is
// never held to that share, however many its MCP processes open.
function openConnections({ isPairedDevice }) {
  let open = 0;
  const unpaired = new Map();
  return {
    // Every connection, of every address, counts toward the total.
    admit(socket) {
      if (open >= MAX_CONNECTIONS) return false;
      open += 1;
      socket.once('close', () => { open -= 1; });
      return true;
    },
    // Once the handshake finished and the certificate is known.
    admitSecure(socket) {
      if (isPairedDevice(peerFingerprint(socket))) return true;
      const source = plainAddress(socket.remoteAddress);
      const held = unpaired.get(source) ?? 0;
      if (held >= MAX_UNPAIRED_PER_SOURCE) return false;
      unpaired.set(source, held + 1);
      socket.once('close', () => {
        const left = (unpaired.get(source) ?? 1) - 1;
        if (left > 0) unpaired.set(source, left);
        else unpaired.delete(source);
      });
      return true;
    }
  };
}

function runnerServer(createServer, tls, handler, connections) {
  const server = createServer(tls, handler);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.on('connection', (socket) => { if (!connections.admit(socket)) socket.destroy(); });
  server.on('secureConnection', (socket) => { if (!connections.admitSecure(socket)) socket.destroy(); });
  server.on('error', () => {});
  server.on('tlsClientError', () => {});
  return server;
}
