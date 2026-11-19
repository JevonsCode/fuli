import { request as httpRequest } from 'node:http';

import { DELEGATION_HEADER, DELEGATION_OPERATION_HEADER } from '../agent-delegation/delegation-header.js';
import { RUNNER_CONSOLE_HEADER } from '../http/request-policy.js';
import { sendJson } from '../http/response.js';
import { SAME_ORIGIN_HEADER } from './protocol.js';

// A runner's way into its host's console (docs/runner.md): the runner's local
// console entry forwards each request here over the paired mutual-TLS channel,
// and the host forwards it to its own console on loopback, so pages, API calls
// and live updates (event streams) behave as on the host. Only a paired runner
// reaches this. Pairing, software maintenance and private host diagnostics
// belong to the host console. Public version information is a separate read.
const BLOCKED = [
  /^\/api\/(?:runners|peer|diagnostics|debug-turns|old-data)(?:\/|$)/,
  /^\/api\/system\/(?:update|diagnostics|log-archives)(?:\/|$)/
];
// What changes the host computer itself, not FULI's data: connecting, adding or
// restarting its clients and opening a session in one. Reached through the
// console on loopback it would pass as the person at the host, so a runner's
// page may read these but never change them (a runner sets up its own clients
// with `fuli setup`).
const HOST_COMPUTER = [
  /^\/api\/system\/(?:client-connection|doctor|graph-migration|cli-path|settings)(?:\/|$)/,
  /^\/api\/system\/npm-copies\/uninstall(?:\/|$)/,
  /^\/api\/(?:data-format|embedding-models|session-launch)(?:\/|$)/
];
// Headers that describe one hop, not the request.
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade',
  'transfer-encoding', 'host', 'authorization', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', SAME_ORIGIN_HEADER, DELEGATION_HEADER, DELEGATION_OPERATION_HEADER, RUNNER_CONSOLE_HEADER]);

// prefix: the runner path under which the console's own paths are carried.
export function relayToConsole(request, response, { consoleOrigin, prefix, fingerprint }) {
  if (!consoleOrigin) {
    sendJson(response, 503, { error: 'console_unavailable' });
    return;
  }
  const incoming = new URL(request.url ?? '/', 'https://runner.invalid');
  // One leading slash and no empty segments: `//host/…` would otherwise read as
  // another address (and pass the checks below), and `/api//runners` as a path
  // they do not match. The target must still be the console itself.
  const path = `/${incoming.pathname.slice(prefix.length).split('/').filter(Boolean).join('/')}`
    + (incoming.pathname.endsWith('/') && incoming.pathname.length > prefix.length + 1 ? '/' : '');
  if (Object.hasOwn(request.headers, DELEGATION_HEADER)) {
    sendJson(response, 403, { error: 'local_user_only', message: 'Delegated console actions run on the host computer.' });
    return;
  }
  if (BLOCKED.some((blocked) => blocked.test(path))) {
    response.setHeader('cache-control', 'no-store');
    sendJson(response, 403, { error: 'host_only', message: 'Open the console on the FULI host to use this operation.' });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && HOST_COMPUTER.some((route) => route.test(path))) {
    sendJson(response, 403, { error: 'host_computer_only',
      message: 'Manage the host installation in its local console. Set up this computer\'s clients with `fuli setup` here.' });
    return;
  }
  const target = new URL(`${path}${incoming.search}`, consoleOrigin);
  if (target.origin !== new URL(consoleOrigin).origin) {
    sendJson(response, 400, { error: 'not_console_path' });
    return;
  }
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name)));
  headers.host = target.host;
  // The runner's entry refused any other site's Origin; its own page's becomes the console's own.
  if (request.headers[SAME_ORIGIN_HEADER] === '1') headers.origin = target.origin;
  headers[RUNNER_CONSOLE_HEADER] = fingerprint.slice(0, 16);
  const upstream = httpRequest(target, { method: request.method, headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, Object.fromEntries(Object.entries(answer.headers)
      .filter(([name]) => !HOP_HEADERS.has(name))));
    answer.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) sendJson(response, 502, { error: 'console_unreachable' });
    else response.destroy();
  });
  // A live update the runner stopped reading ends here too.
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}
