import { z } from 'zod';

import { isLoopbackAddress } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// The console's data format migration page (rec#17 D-09 part 2). The preview
// is open to the console like any read. Apply and undo change real data: no
// Agent tool reaches them, and they are accepted only on loopback. Loopback
// and the repeated digest do not show that a person decided (any process of
// this OS account can call them), so FULI records entrypoint http with
// presence unverified. A whole-store restore is not offered here: it runs
// only from `fuli migrate restore` with FULI stopped.

const LOCAL_CONSOLE = Object.freeze({ entrypoint: 'http' });
const BODIES = Object.freeze({
  apply: z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  rollback: z.object({ label: z.string().min(1).max(128), migrationId: z.string().min(1).max(128) }).strict()
});

export async function handleDataFormatApiRequest({ request, response, url, migrations }) {
  if (!url.pathname.startsWith('/api/data-format')) return false;
  if (!migrations) {
    sendJson(response, 503, { error: 'Data format migrations need a local FULI installation' });
    return true;
  }
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/api/data-format' && request.method === 'GET') {
    sendJson(response, 200, await migrations.preview());
    return true;
  }
  const action = /^\/api\/data-format\/(apply|rollback)$/.exec(url.pathname)?.[1];
  if (!action || request.method !== 'POST') {
    sendJson(response, action ? 405 : 404, { error: action ? 'Method not allowed' : 'Not found' });
    return true;
  }
  if (!isLoopbackAddress(request.socket?.remoteAddress)) {
    sendJson(response, 403, { error: 'Data format migrations are confirmed only on this computer',
      code: 'local_user_only' });
    return true;
  }
  const parsed = BODIES[action].safeParse(await readJson(request));
  if (!parsed.success) throw new TypeError('Invalid data format request');
  const body = parsed.data;
  sendJson(response, 200, action === 'apply'
    ? await migrations.apply({ digest: body.digest, actor: LOCAL_CONSOLE })
    : await migrations.rollback({ label: body.label, migrationId: body.migrationId, actor: LOCAL_CONSOLE }));
  return true;
}
