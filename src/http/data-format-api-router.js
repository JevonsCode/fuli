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
  'dismiss-notices': z.object({ ids: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(200) }).strict(),
  restore: z.object({ label, backupRef, currentDigest: z.string().min(1).max(128).nullable() }).strict()
});
const ACTIONS = /^\/api\/data-format\/(apply|rollback|prune|restore|dismiss-notices)$/;
const RESTORE_READS = new Set(['/api/data-format/restore', '/api/data-format/restore/status']);
// The graph step's whole-graph backup and its restore (console-graph-backup.js):
// they stop FULI, so only this computer starts them, as an update.
const GRAPH_BACKUP = '/api/data-format/graph-backup';
const formatVersion = z.coerce.number().int().positive().max(9999);
const GRAPH_BODIES = Object.freeze({
  backup: z.object({ version: formatVersion }).strict(),
  restore: z.object({ version: formatVersion, name: z.string().min(1).max(128) }).strict(),
  reveal: z.object({ version: formatVersion, name: z.string().min(1).max(128) }).strict()
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
  if (url.pathname.startsWith(GRAPH_BACKUP)) return handleGraphBackup({ request, response, url, graphBackup: migrations.graphBackup });
  if (RESTORE_READS.has(url.pathname) && request.method === 'GET') {
    if (refuseRemoteDecision(request, response, 'A whole-store restore is prepared only on this computer', { directHost: true })) return true;
    sendJson(response, 200, restoreRead(migrations.restore, url));
    return true;
  }
  const action = ACTIONS.exec(url.pathname)?.[1];
  if (!action || request.method !== 'POST') {
    sendJson(response, action || RESTORE_READS.has(url.pathname) ? 405 : 404,
      { error: action || RESTORE_READS.has(url.pathname) ? 'Method not allowed' : 'Not found' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'Data format migrations are confirmed only on this computer', { directHost: true })) return true;
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
  'dismiss-notices': (migrations, body) => migrations.dismissNotices(body.ids),
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

// GET: the newest backup for a format version, the room for another and the
// last job; POST …/graph-backup starts one, …/graph-backup/restore restores
// one, …/graph-backup/reveal shows its folder. Paths are read on loopback only.
async function handleGraphBackup({ request, response, url, graphBackup }) {
  const action = { [GRAPH_BACKUP]: 'backup', [`${GRAPH_BACKUP}/restore`]: 'restore', [`${GRAPH_BACKUP}/reveal`]: 'reveal' }[url.pathname];
  if (!action) {
    sendJson(response, 404, { error: 'Not found' });
    return true;
  }
  if (!graphBackup) throw new TypeError('A graph backup needs a local FULI installation');
  if (refuseRemoteDecision(request, response, 'The graph is backed up only on this computer', { directHost: true })) return true;
  if (action === 'backup' && request.method === 'GET') {
    const version = formatVersion.safeParse(url.searchParams.get('version'));
    if (!version.success) throw new TypeError('Name the data format version the backup is for');
    sendJson(response, 200, await graphBackup.read(version.data));
    return true;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  const parsed = GRAPH_BODIES[action].safeParse(await readJson(request));
  if (!parsed.success) throw new TypeError('Invalid graph backup request');
  const run = { backup: () => graphBackup.startBackup(parsed.data), restore: () => graphBackup.startRestore(parsed.data),
    reveal: () => graphBackup.reveal(parsed.data) }[action];
  sendJson(response, 200, await run());
  return true;
}
