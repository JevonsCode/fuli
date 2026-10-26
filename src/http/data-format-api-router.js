import { z } from 'zod';

import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// The console's data format migration page (rec#17 D-09 part 2). The preview
// is open to the console like any read. Apply, undo, a prune check and a
// whole-store restore change real data: no Agent tool reaches them, and they
// are accepted only on loopback. Loopback and the repeated digest do not show
// that a person decided (any process of this OS account can call them), so
// FULI records entrypoint http with presence unverified. A restore needs the
// store unused: the console restarts FULI around it (console-restore.js), and
// what it discards is read on loopback only, before the person confirms.

const LOCAL_CONSOLE = Object.freeze({ entrypoint: 'http' });
const label = z.string().min(1).max(128);
const backupRef = z.string().min(1).max(256);
const BODIES = Object.freeze({
  apply: z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  rollback: z.object({ label, migrationId: z.string().min(1).max(128) }).strict(),
  prune: z.object({}).strict(),
  restore: z.object({ label, backupRef, currentDigest: z.string().min(1).max(128).nullable() }).strict()
});
const ACTIONS = /^\/api\/data-format\/(apply|rollback|prune|restore)$/;
const RESTORE_READS = new Set(['/api/data-format/restore', '/api/data-format/restore/status']);

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
  if (RESTORE_READS.has(url.pathname) && request.method === 'GET') {
    if (refuseRemoteDecision(request, response, 'A whole-store restore is prepared only on this computer')) return true;
    sendJson(response, 200, restoreRead(migrations.restore, url));
    return true;
  }
  const action = ACTIONS.exec(url.pathname)?.[1];
  if (!action || request.method !== 'POST') {
    sendJson(response, action || RESTORE_READS.has(url.pathname) ? 405 : 404,
      { error: action || RESTORE_READS.has(url.pathname) ? 'Method not allowed' : 'Not found' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'Data format migrations are confirmed only on this computer')) return true;
  const parsed = BODIES[action].safeParse(await readJson(request));
  if (!parsed.success) throw new TypeError('Invalid data format request');
  sendJson(response, 200, await ACTION_HANDLERS[action](migrations, parsed.data));
  return true;
}

const ACTION_HANDLERS = Object.freeze({
  apply: (migrations, body) => migrations.apply({ digest: body.digest, actor: LOCAL_CONSOLE }),
  rollback: (migrations, body) => migrations.rollback({ label: body.label, migrationId: body.migrationId,
    actor: LOCAL_CONSOLE }),
  prune: async (migrations) => ({ pruned: await migrations.retain() }),
  restore: (migrations, body) => restorePort(migrations.restore).start(body)
});

// Without a label: the stores with backups and the latest restore's outcome.
// With a label and backup: what restoring it discards, by counts only.
function restoreRead(restore, url) {
  const port = restorePort(restore);
  if (url.pathname.endsWith('/status')) return { restore: port.status() };
  const chosen = url.searchParams.get('label');
  if (chosen === null) return { stores: port.choices(), restore: port.status() };
  const backup = url.searchParams.get('backup');
  if (!label.safeParse(chosen).success || !backupRef.safeParse(backup).success) {
    throw new TypeError('Name a store and one of its backups');
  }
  return { impact: port.describe(chosen, backup) };
}

function restorePort(restore) {
  if (!restore) throw new TypeError('A whole-store restore needs a local FULI installation');
  return restore;
}
