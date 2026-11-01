import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { isLoopbackAddress } from './request-policy.js';
import { sendJson } from './response.js';

const PAGE_ROUTE = /^\/app-pages\/([^/]+)(\/.*)?$/;
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
});
const REFUSAL_STATUS = Object.freeze({ not_found: 404, not_page: 404 });

// A page app's files for the console's app frame (#346 0.23 Apps), on this
// computer only. It answers before the console's request policy, because the
// page runs as an opaque origin: the console embeds it in a sandboxed iframe
// and every response here carries the CSP sandbox too, so even opened on its
// own it never gets the console's origin, cookies or storage, and its own
// files reach it as cross-site requests the console policy would refuse.
// What this route itself asks: GET or HEAD, the Host is this server's
// loopback authority (no DNS rebinding, no LAN) and the run gate accepts the
// active version (src/agent-apps/pages.js). The page may load only its own
// files and talks to nothing: no fetch, no form posts, no other frames;
// frame-ancestors lets only the console embed it. A module script or font
// from the opaque origin is a CORS request with Origin null, so those
// answer with that origin; the files are the app's own approved code, no data.
export async function handleAgentAppPageRequest({ request, response, app, authority }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const route = url.pathname.match(PAGE_ROUTE);
  if (!route) return false;
  if (!authority || request.headers.host !== authority || !isLoopbackAddress(request.socket?.remoteAddress)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return true;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  const agentApps = app.agentApps;
  if (!agentApps) {
    sendJson(response, 503, { code: 'agent_apps_unavailable', error: 'Agent apps need a local FULI installation' });
    return true;
  }
  const [, encodedAppId, encodedPath] = route;
  // Relative links in index.html resolve below the app's folder only with the trailing slash.
  if (encodedPath === undefined) {
    response.writeHead(308, { location: `/app-pages/${encodedAppId}/`, 'cache-control': 'no-store' });
    response.end();
    return true;
  }
  const appId = decoded(encodedAppId);
  const path = decoded(encodedPath.slice(1));
  const page = appId === null || path === null || path.includes('\\') || path.includes('\0')
    ? { status: 'not_found', message: 'No such page file.' } : agentApps.pageFile({ appId, path });
  if (page.status !== 'ready') {
    sendJson(response, REFUSAL_STATUS[page.status] ?? 409, { code: page.reason ?? page.status, error: page.message });
    return true;
  }
  const body = readFileSync(page.filePath);
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(page.filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'content-security-policy': pagePolicy(authority, encodedAppId),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Checked against the run gate again on every load, so never reused.
    'cache-control': 'no-store',
    ...(request.headers.origin === 'null' ? { 'access-control-allow-origin': 'null', vary: 'origin' } : { vary: 'origin' })
  });
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}

function pagePolicy(authority, encodedAppId) {
  const own = `http://${authority}/app-pages/${encodedAppId}/`;
  return [
    'sandbox allow-scripts allow-forms',
    "default-src 'none'",
    `script-src ${own}`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `font-src ${own}`,
    `media-src ${own}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors http://${authority}`
  ].join('; ');
}

function decoded(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
