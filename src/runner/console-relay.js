import { request as httpRequest } from 'node:http';

import { sendJson } from '../http/response.js';
import { SAME_ORIGIN_HEADER } from './protocol.js';

// A runner's way into its host's console (docs/runner.md): the runner's local
// console entry forwards each request here over the paired mutual-TLS channel,
// and the host forwards it to its own console on loopback, so pages, API calls
// and live updates (event streams) behave as on the host. Only a paired runner
// reaches this. What changes who may reach the host stays on the host itself:
// runners and LAN pairing are managed only there, never through a runner.
const BLOCKED = [/^\/api\/runners(?:\/|$)/, /^\/api\/peer(?:\/|$)/];
// What changes the host computer itself, not FULI's data: connecting, adding or
// restarting its clients and opening a session in one. Reached through the
// console on loopback it would pass as the person at the host, so a runner's
// page may read these but never change them (a runner sets up its own clients
// with `fuli setup`).
const HOST_COMPUTER = [/^\/api\/system\/client-connection(?:\/|$)/, /^\/api\/session-launch(?:\/|$)/];
// Headers that describe one hop, not the request.
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade',
  'transfer-encoding', 'host', 'authorization', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', SAME_ORIGIN_HEADER]);
const RUNNER_HEADER = 'x-fuli-runner';

// prefix: the runner path under which the console's own paths are carried.
export function relayToConsole(request, response, { consoleOrigin, prefix, fingerprint }) {
  if (!consoleOrigin) {
    sendJson(response, 503, { error: 'console_unavailable' });
    return;
  }
  const incoming = new URL(request.url ?? '/', 'https://runner.invalid');
  const path = incoming.pathname.slice(prefix.length) || '/';
  if (BLOCKED.some((blocked) => blocked.test(path))) {
    sendJson(response, 403, { error: 'host_only', message: 'Runners and LAN pairing are managed only on the host itself.' });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && HOST_COMPUTER.some((route) => route.test(path))) {
    sendJson(response, 403, { error: 'host_computer_only',
      message: 'This changes the host computer\'s own clients; set up this computer\'s clients with `fuli setup` here.' });
    return;
  }
  const target = new URL(`${path}${incoming.search}`, consoleOrigin);
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name)));
  headers.host = target.host;
  // The runner's entry refused any other site's Origin; its own page's becomes the console's own.
  if (request.headers[SAME_ORIGIN_HEADER] === '1') headers.origin = target.origin;
  headers[RUNNER_HEADER] = fingerprint.slice(0, 16);
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
