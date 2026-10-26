import { readJson, sendJson } from './response.js';

// The client link manifest: what the console reads, the person's 「检查更新」,
// the one-click apply of the update it showed, and the daily auto-update switch.
export async function handleClientLinksRequest({ request, response, url, clientLinks }) {
  if (!clientLinks || !url.pathname.startsWith('/api/client-links')) return false;
  const route = `${request.method} ${url.pathname}`;
  if (route === 'GET /api/client-links') {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, clientLinks.current());
  } else if (route === 'POST /api/client-links/check') {
    sendJson(response, 200, await clientLinks.check());
  } else if (route === 'POST /api/client-links/apply') {
    const { digest } = await readJson(request);
    if (typeof digest !== 'string' || !digest) throw new TypeError('digest of the checked update is required');
    sendJson(response, 200, clientLinks.apply(digest));
  } else if (route === 'PUT /api/client-links/auto-update') {
    sendJson(response, 200, clientLinks.setAutoUpdate((await readJson(request)).enabled));
  } else {
    return false;
  }
  return true;
}
