import { createServer as createHttpServer } from 'node:http';

import { sendJson } from '../http/response.js';
import { isFetchBlockedPort } from '../server/blocked-ports.js';
import { isGuestSourceAddress } from '../server/lan-access.js';
import { listenFetchableServer } from '../server/listen.js';
import { createFailedBearerLimit } from './failed-bearer-limit.js';

// The guest link listener: its own HTTP servers on this computer's private
// network addresses, apart from the console, so a guest token never meets the
// console's policy or handlers. Before any route a request must come from a
// guest source address (lan-access.js), name one of the bound addresses as its
// Host, carry no Origin (no web page may call it) and present a live link's
// token as `Authorization: Bearer fgl_…`; a token anywhere else is never read.
// Unknown, expired and revoked tokens are one answer. A source with too many
// failed tokens is refused until they age out; onRefused hears of each of
// those refusals. rebind follows the computer's addresses as they change.
const GUEST_PREFIX = '/guest/1/';
const SHUTDOWN_GRACE_MS = 2000;
// A client gets this long to send its headers, so a slow sender cannot hold a socket.
const HEADERS_TIMEOUT_MS = 10_000;
// A whole request (a search or an MCP call) arrives well within this.
const REQUEST_TIMEOUT_MS = 30_000;
// An idle kept-alive connection is closed after this; clients reconnect cheaply.
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
// A few guests at a time per address; past this new connections are dropped.
const MAX_CONNECTIONS = 64;
// Guest clients send a handful of headers; more is not a guest client.
const MAX_HEADERS_COUNT = 50;

export async function startGuestListener({ addresses, port, authenticate, route, sourceAllowed = isGuestSourceAddress,
  onRefused = () => {}, isBlockedPort = isFetchBlockedPort, failedBearers = createFailedBearerLimit(),
  createServer = createHttpServer }) {
  const bound = new Map();
  let order = [];
  let boundPort = port;

  const handler = (request, response) => {
    response.setHeader('cache-control', 'no-store');
    handleGuestRequest(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
      else if (!response.writableEnded) response.destroy();
    });
  };

  async function handleGuestRequest(request, response) {
    const plain = (address) => String(address ?? '').replace(/^::ffff:/i, '');
    const source = plain(request.socket?.remoteAddress);
    const authorities = new Set([...bound.keys()].map((address) => `${address}:${boundPort}`));
    if (!sourceAllowed(source, plain(request.socket?.localAddress))
      || !authorities.has(String(request.headers.host ?? '').toLowerCase()) || request.headers.origin !== undefined) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    const { pathname } = new URL(request.url ?? '/', 'http://guest.invalid');
    if (!pathname.startsWith(GUEST_PREFIX)) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (failedBearers.blocked(source)) {
      onRefused(source);
      sendJson(response, 429, { error: 'too_many_attempts' });
      return;
    }
    const opened = authenticate(bearerToken(request.headers.authorization));
    if (!opened.ok) {
      failedBearers.fail(source);
      onRefused(source);
      response.setHeader('www-authenticate', 'Bearer');
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (!await route(request, response, { link: opened.link, pathname })) sendJson(response, 404, { error: 'not_found' });
  }

  // Serves exactly addresses (in that order): closes the servers of addresses
  // that are gone and opens the new ones on the same port. Answers how many
  // addresses are bound; an address that cannot be bound is left out.
  async function rebind(next) {
    order = [...next];
    await Promise.all([...bound].filter(([address]) => !order.includes(address)).map(([address, server]) => {
      bound.delete(address);
      return closeServer(server);
    }));
    let firstError = null;
    for (const address of order.filter((candidate) => !bound.has(candidate))) {
      const server = guestServer(createServer, handler);
      try {
        await listenFetchableServer(server, boundPort, address, { isBlockedPort });
      } catch (error) {
        firstError ??= error;
        continue;
      }
      boundPort = server.address().port;
      bound.set(address, server);
    }
    if (!bound.size) throw firstError ?? new Error('The guest listener has no address to bind');
    return bound.size;
  }

  await rebind(addresses);
  return {
    get port() { return boundPort; },
    // The bound addresses with the port, in the order they were given.
    get authorities() { return order.filter((address) => bound.has(address)).map((address) => `${address}:${boundPort}`); },
    rebind,
    close: () => Promise.all([...bound.values()].map(closeServer)).then(() => bound.clear())
  };
}

function guestServer(createServer, handler) {
  const server = createServer(handler);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.on('error', () => {});
  return server;
}

function bearerToken(header) {
  const match = typeof header === 'string' ? /^Bearer[ \t]+(\S+)$/i.exec(header) : null;
  return match ? match[1] : null;
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), SHUTDOWN_GRACE_MS).unref();
  });
}
