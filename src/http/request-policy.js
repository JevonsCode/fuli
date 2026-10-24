import { timingSafeEqual } from 'node:crypto';

import { sendJson } from './response.js';

export function localServerAuthority(address) {
  if (!address || typeof address === 'string') return null;
  if (!Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65535) {
    return null;
  }
  return address.port === 80 ? '127.0.0.1' : `127.0.0.1:${address.port}`;
}

export function rejectDisallowedRequest({ request, response, authority }) {
  return rejectRequestOutsidePolicy({ request, response, authority });
}

export function rejectRequestOutsidePolicy({
  request,
  response,
  authority,
  lanAuthorities = [],
  lanAccessToken = null
}) {
  const origin = request.headers.origin;
  const requestAuthority = request.headers.host;
  const lanRequest = lanAuthorities.includes(requestAuthority);
  const loopbackRequest = requestAuthority === authority;
  if (
    !authority ||
    (requestAuthority !== authority && !lanRequest) ||
    (lanAuthorities.length > 0 && loopbackRequest && !isLoopbackAddress(request.socket?.remoteAddress)) ||
    (origin !== undefined && origin !== `http://${requestAuthority}`) ||
    (fetchSiteValues(request).includes('cross-site') && !isCrossSiteNavigation(request))
  ) {
    sendJson(response, 403, { error: 'Forbidden' });
    return true;
  }

  if (lanRequest && !hasLanAccess(request.headers.authorization, lanAccessToken)) {
    response.setHeader('www-authenticate', 'Basic realm="FULI LAN", charset="UTF-8"');
    sendJson(response, 401, { error: 'LAN access code required' });
    return true;
  }

  if (requiresJson(request) && !isJson(request.headers['content-type'])) {
    sendJson(response, 415, { error: 'Unsupported media type' });
    return true;
  }

  return false;
}

// The person opened the console from a link on another site (a GitHub issue,
// a chat app): a top-level GET of a whole document. The other site cannot
// read that page and the request changes nothing, so it is not forgery; the
// server answers it with the static console only, never an API handler
// (rec#40 A1). Frames, scripts and fetches from another site stay refused.
// A repeated Sec-Fetch-Site reaches Node joined by commas; any cross-site
// value counts, so a duplicate never hides one (a browser sends it once).
function fetchSiteValues(request) {
  return String(request.headers['sec-fetch-site'] ?? '').split(',').map((value) => value.trim().toLowerCase());
}

export function isCrossSiteNavigation(request) {
  const header = (name) => String(request.headers[name] ?? '').toLowerCase();
  return ['GET', 'HEAD'].includes(request.method) && header('sec-fetch-site') === 'cross-site'
    && header('sec-fetch-mode') === 'navigate' && header('sec-fetch-dest') === 'document';
}

function hasLanAccess(authorization, accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) return false;
  const expected = `Basic ${Buffer.from(`fuli:${accessToken}`).toString('base64')}`;
  if (typeof authorization !== 'string') {
    return false;
  }
  const providedBytes = Buffer.from(authorization);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes);
}

// A console route the interface catalog marks local_user_only: the person's
// own decision on this computer. A request from anywhere else is answered 403
// with `error` and true is returned; a loopback request returns false.
export function refuseRemoteDecision(request, response, error) {
  if (isLoopbackAddress(request.socket?.remoteAddress)) return false;
  sendJson(response, 403, { error, code: 'local_user_only' });
  return true;
}

export function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function requiresJson(request) {
  if (!['PATCH', 'POST', 'PUT'].includes(request.method)) return false;
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  return pathname.startsWith('/api/') || pathname.startsWith('/employee-workspaces/');
}

function isJson(contentType) {
  if (typeof contentType !== 'string') return false;
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}
