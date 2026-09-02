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
  const fetchSite = request.headers['sec-fetch-site'];
  const requestAuthority = request.headers.host;
  const lanRequest = lanAuthorities.includes(requestAuthority);
  const loopbackRequest = requestAuthority === authority;
  if (
    !authority ||
    (requestAuthority !== authority && !lanRequest) ||
    (lanAuthorities.length > 0 && loopbackRequest && !isLoopbackAddress(request.socket?.remoteAddress)) ||
    (origin !== undefined && origin !== `http://${requestAuthority}`) ||
    (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site')
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

function isLoopbackAddress(address) {
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
