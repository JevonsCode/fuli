import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { holdFormattedSnapshot } from '../../packages/roundtable/src/storage/database-format.js';
import { PROJECT_MOVES_FILE, PROJECT_MOVES_FORMAT } from './move-store.js';
import { RUNNER_PATHS, SCOPE_DIGEST_HEADER, SCOPE_ENVELOPE_MAX_BYTES } from './protocol.js';

// A former owner only follows projects whose transfer it finished locally.
// A later transfer or pairing supersedes the receipt. The host independently
// checks its current ownership generation and grants on both export requests.
export function forwardedProjects(dataDir, descriptor, runner) {
  function read(after, project) {
    const local = descriptor();
    if (!local || local.device === local.authority) return [];
    const epoch = runner.projectPairing(local.authority);
    const file = join(dataDir, PROJECT_MOVES_FILE);
    if (!epoch || !existsSync(file)) return [];
    const db = holdFormattedSnapshot(file, PROJECT_MOVES_FORMAT);
    try {
      return db.prepare(`SELECT p.project, p.target AS owner, p.generation+1 AS generation, p.pairing, 'owned' AS state
        FROM move_participants p WHERE p.space=? AND p.source=? AND p.target=? AND p.pairing=?
        AND p.gate_role='owner' AND p.step='forwarded' AND p.project>? AND (? IS NULL OR p.project=?)
        AND NOT EXISTS (SELECT 1 FROM move_participants later WHERE later.space=p.space AND later.project=p.project
          AND later.generation>p.generation AND later.step<>'aborted') ORDER BY p.project LIMIT 50`)
        .all(local.spaceId, local.device, local.authority, epoch, after, project, project);
    } finally { db.close(); }
  }
  return { remotePage: (_device, after) => read(after, null), remoteOwner: (_device, project) => read('', project)[0] ?? null };
}

export function hostCopySource(connection, spaceId) {
  async function get(record, part, signal) {
    const query = new URLSearchParams({ scope: 'project:' + record.project, part, pairing: record.pairing,
      generation: String(record.generation) });
    return connection.getText(RUNNER_PATHS.scope + '?' + query, { maxBytes: part === 'digest' ? 16384 : SCOPE_ENVELOPE_MAX_BYTES,
      timeoutMs: 30_000, signal });
  }
  return {
    async summary(record, signal) {
      const reply = await get(record, 'digest', signal);
      if (reply.status !== 200 || reply.tooLarge) return { ok: false, code: reply.reachable ? 'export_unavailable' : 'owner_offline' };
      const body = JSON.parse(reply.text);
      const ok = body.spaceId === spaceId && body.scope === 'project:' + record.project && body.complete === true;
      return { ok: true, result: { ok, digest: body.digest, code: 'export_unverified' } };
    },
    async envelope(record, summary, signal) {
      const reply = await get(record, 'envelope', signal);
      if (reply.status !== 200 || reply.tooLarge || reply.headers.get(SCOPE_DIGEST_HEADER) !== summary.digest) {
        return { ok: false, code: 'export_changed' };
      }
      return { ok: true, text: reply.text };
    }
  };
}
