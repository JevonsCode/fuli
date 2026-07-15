import { sendJson } from './response.js';

export function localServerAuthority(address) {
  if (!address || typeof address === 'string') return null;
  if (!Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65535) {
    return null;
  }
  return address.port === 80 ? '127.0.0.1' : `127.0.0.1:${address.port}`;
}

export function rejectDisallowedRequest({ request, response, authority }) {
  const origin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  if (
    !authority ||
    request.headers.host !== authority ||
    (origin !== undefined && origin !== `http://${authority}`) ||
    (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site')
  ) {
    sendJson(response, 403, { error: 'Forbidden' });
    return true;
  }

  if (requiresJson(request) && !isJson(request.headers['content-type'])) {
    sendJson(response, 415, { error: 'Unsupported media type' });
    return true;
  }

  return false;
}

function requiresJson(request) {
  if (request.method !== 'POST') return false;
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  return pathname.startsWith('/api/');
}

function isJson(contentType) {
  if (typeof contentType !== 'string') return false;
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}
