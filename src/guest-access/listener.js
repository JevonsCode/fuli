import { createServer } from 'node:http';

import { sendJson } from '../http/response.js';
import { isFetchBlockedPort } from '../server/blocked-ports.js';
import { isGuestSourceAddress } from '../server/lan-access.js';
import { listenFetchableServer } from '../server/listen.js';
import { createFailedBearerLimit } from './failed-bearer-limit.js';

// The guest link listener: its own HTTP servers on this computer's private
// network addresses, apart from the console, so a guest token never meets the
// console's policy or handlers. Before any route a request must come from a
// private or carrier-grade NAT address, name one of the bound addresses as its
// Host, carry no Origin (no web page may call it) and present a live link's
// token as `Authorization: Bearer fgl_…`; a token anywhere else is never read.
// Unknown, expired and revoked tokens are one answer. A source with
// too many failed tokens is refused until they age out.
const GUEST_PREFIX = '/guest/1/';
const SHUTDOWN_GRACE_MS = 2000;

export async function startGuestListener({ addresses, port, authenticate, route, sourceAllowed = isGuestSourceAddress,
  isBlockedPort = isFetchBlockedPort, failedBearers = createFailedBearerLimit() }) {
  const authorities = new Set();
  const handler = (request, response) => {
    response.setHeader('cache-control', 'no-store');
    handleGuestRequest(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
      else if (!response.writableEnded) response.destroy();
    });
  };

  async function handleGuestRequest(request, response) {
    const source = String(request.socket?.remoteAddress ?? '').replace(/^::ffff:/i, '');
    if (!sourceAllowed(source) || !authorities.has(String(request.headers.host ?? '').toLowerCase())
      || request.headers.origin !== undefined) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    const { pathname } = new URL(request.url ?? '/', 'http://guest.invalid');
    if (!pathname.startsWith(GUEST_PREFIX)) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (failedBearers.blocked(source)) {
      sendJson(response, 429, { error: 'too_many_attempts' });
      return;
    }
    const opened = authenticate(bearerToken(request.headers.authorization));
    if (!opened.ok) {
      failedBearers.fail(source);
      response.setHeader('www-authenticate', 'Bearer');
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (!await route(request, response, { link: opened.link, pathname })) sendJson(response, 404, { error: 'not_found' });
  }

  const servers = [];
  let boundPort = port;
  let firstError = null;
  for (const address of addresses) {
    const server = createServer(handler);
    server.on('error', () => {});
    try {
      await listenFetchableServer(server, boundPort, address, { isBlockedPort });
    } catch (error) {
      firstError ??= error;
      continue;
    }
    boundPort = server.address().port;
    authorities.add(`${address}:${boundPort}`);
    servers.push(server);
  }
  if (!servers.length) throw firstError ?? new Error('The guest listener has no address to bind');

  return {
    port: boundPort,
    authorities: [...authorities],
    close: () => Promise.all(servers.map(server => closeServer(server)))
  };
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
