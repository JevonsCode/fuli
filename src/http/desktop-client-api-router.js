import { sendJson } from './response.js';

// Whether this computer's FULI desktop client opens fuli:// links
// (src/desktop/desktop-client-links.js); the console in a browser then offers
// 「在客户端打开」.

const DESKTOP_CLIENT_PATH = '/api/system/desktop-client';

export function handleDesktopClientRequest({ request, response, url, system }) {
  if (url.pathname !== DESKTOP_CLIENT_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  sendJson(response, 200, { opensLinks: system?.desktopClientOpensLinks?.() === true });
  return true;
}
