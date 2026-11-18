import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { handleClientConnectionRequest } from '../http/client-connection-api-router.js';
import { sendJson } from '../http/response.js';
import { FULI_VERSION } from '../package-metadata.js';
import { listenServer } from '../server/listen.js';
import { RUNNER_PATHS, SAME_ORIGIN_HEADER } from './protocol.js';

// A runner's console entry (docs/runner.md): on this computer's loopback, at
// the port its own console would use, so FULI.app, `fuli open` and the
// receipt links the host gives (http://127.0.0.1:<port>/…) open the host's
// console. Each request goes to the host over the paired channel as it is
// (console-relay.js on the host); while the host is away, a page says so and
// how many writes wait in the outbox. STATUS_PATH answers here, never from the
// host: it is how `fuli status` and the app know this entry is running.
// 客户端接入 (/api/system/client-connection…) answers here from `clients`
// (runner-clients.js): the clients that matter on a runner are its own.
export const STATUS_PATH = '/__fuli-runner/status';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade',
  'transfer-encoding', 'host', 'origin', 'referer']);


export async function startFollowerConsole({ dataDir, port, store, connection, clients = null, pid = process.pid,
  createServer = createHttpServer }) {
  let authorities = new Set();
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
      else response.destroy();
    });
  });

  async function handle(request, response) {
    // Only this computer, under its own name: another site's page cannot rebind a name onto it.
    if (!LOOPBACK.has(request.socket?.remoteAddress) || !authorities.has(String(request.headers.host ?? '').toLowerCase())) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    // Another site's page may not act on the host through this entry: its Origin is refused here,
    // before the channel, where the host could no longer tell it from this computer's own page.
    const origin = request.headers.origin;
    if (origin !== undefined && !authorities.has(originAuthority(origin))) {
      sendJson(response, 403, { error: 'cross_origin' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://runner.invalid');
    if (clients && await handleClientConnectionRequest({ request, response, url, system: clients })) return;
    const host = store.host();
    if (url.pathname === STATUS_PATH) {
      const reached = host ? await connection.connect() : null;
      sendJson(response, 200, { kind: 'fuli-runner-console', pid, dataDir, version: FULI_VERSION,
        host: host ? { name: host.name, reachable: Boolean(reached), address: reached?.address ?? null } : null,
        outbox: store.outbox().queued });
      return;
    }
    const reached = host ? await connection.connect() : null;
    if (!reached) return away(request, response, host);
    const target = new URL(`${RUNNER_PATHS.console}${request.url ?? '/'}`, reached.origin);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name)));
    if (origin !== undefined) headers[SAME_ORIGIN_HEADER] = '1';
    const upstream = httpsRequest(target, { method: request.method, agent: reached.agent, headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, Object.fromEntries(Object.entries(answer.headers)
        .filter(([name]) => !HOP_HEADERS.has(name))));
      answer.pipe(response);
    });
    upstream.on('error', () => {
      connection.drop();
      if (!response.headersSent) away(request, response, host);
      else response.destroy();
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  }

  function away(request, response, host) {
    const queued = store.outbox().queued;
    if (!String(request.headers.accept ?? '').includes('text/html')) {
      sendJson(response, 503, { error: host ? 'host_unreachable' : 'not_paired', outbox: queued });
      return;
    }
    response.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
    response.end(awayPage({ hostName: host?.name ?? null, queued }));
  }

  await listenServer(server, port, '127.0.0.1');
  const bound = server.address().port;
  authorities = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  return { url: `http://127.0.0.1:${bound}`, close: () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  }) };
}

function originAuthority(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function awayPage({ hostName, queued }) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  const title = hostName ? `${escape(hostName)} 暂时连不上 · The host is away` : '这台电脑还没有配对主机 · Not paired';
  const body = hostName
    ? `<p>这台电脑是运行机，复利在主机 <b>${escape(hostName)}</b> 上。主机回来后这个页面会显示它的控制台。</p>
<p>This computer is a runner; its FULI is on <b>${escape(hostName)}</b>. Its console shows here once the host answers.</p>
<p>待补交的记录 / Waiting in the outbox: <b>${queued}</b></p>`
    : '<p>运行 <code>fuli runner join</code> 和主机配对。 / Pair with a host with <code>fuli runner join</code>.</p>';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="15"><title>FULI</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}
.beta{display:inline-block;margin-left:8px;padding:0 6px;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;vertical-align:middle;color:#3b5bdb;background:#e8edff}
@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}.beta{color:#a5b8ff;background:#1f2a4d}}</style></head>
<body><h1 style="font-size:20px">${title}<span class="beta" title="测试中的功能 · In testing">Beta</span></h1>${body}</body></html>`;
}
