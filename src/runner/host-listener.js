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
// Any device on the network can open connections here, finished handshake or
// not: the certificate is the route's to judge. So every connection counts
// against its source address's share until it has shown a paired runner's
// certificate, and one device cannot hold every connection and keep the paired
// runners out. It is far more than pairing, or a runner's handshakes in
// flight, need from one address.
const MAX_UNPAIRED_PER_SOURCE = 24;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HEADERS_COUNT = 50;

// isPairedDevice(fingerprint): whether that certificate is a runner this host
// knows. A connection is counted against its source's share until it shows one.
// limits: the two counts above, smaller in a test.
export async function startRunnerListener({ identity, addresses, port, route, sourceAllowed = isGuestSourceAddress,
  isPairedDevice = () => false, createServer = createHttpsServer,
  limits = { total: MAX_CONNECTIONS, unpairedPerSource: MAX_UNPAIRED_PER_SOURCE } }) {
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

  const connections = openConnections({ isPairedDevice, limits });
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

// What the servers of every address hold together: the total over all of
// them, and each source address's share of the connections not yet shown to be
// a paired runner's. Both are counted as the TCP connection arrives, before
// TLS, so a device that never finishes its handshake (each may hang
// HANDSHAKE_TIMEOUT_MS, then open again) is held to the share like any other.
// Once the handshake shows a paired runner's certificate, that connection
// gives its source's share back, so a runner's MCP processes are never held
// to it. The TCP and TLS sockets are different objects of one connection; its
// remote address and port name it in both.
function openConnections({ isPairedDevice, limits }) {
  let open = 0;
  const unpaired = new Map();
  const refunds = new Map();
  const connectionOf = (socket) => `${plainAddress(socket.remoteAddress)}|${socket.remotePort}`;
  return {
    admit(socket) {
      const source = plainAddress(socket.remoteAddress);
      if (open >= limits.total || (unpaired.get(source) ?? 0) >= limits.unpairedPerSource) return false;
      open += 1;
      unpaired.set(source, (unpaired.get(source) ?? 0) + 1);
      const key = connectionOf(socket);
      let held = true;
      const refund = () => {
        if (!held) return;
        held = false;
        refunds.delete(key);
        const left = unpaired.get(source) - 1;
        if (left > 0) unpaired.set(source, left);
        else unpaired.delete(source);
      };
      refunds.set(key, refund);
      socket.once('close', () => {
        open -= 1;
        refund();
      });
      return true;
    },
    // The handshake finished: a paired runner's connection gives its source's share back.
    settled(socket) {
      if (isPairedDevice(peerFingerprint(socket))) refunds.get(connectionOf(socket))?.();
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
  server.on('secureConnection', (socket) => connections.settled(socket));
  server.on('error', () => {});
  server.on('tlsClientError', () => {});
  return server;
}
