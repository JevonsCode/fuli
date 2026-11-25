import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { jsonFormat, readJsonRecord, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { replicaContentMatches } from './replica-content.js';
import { readOwnerExport } from './owner-export.js';

export const PROJECT_COPIES_FORMAT = jsonFormat({ store: 'project-copies', versions: [1] });
const validDigest = text => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text);
const sameOwner = (a, b) => a?.state === 'owned' && b?.state === 'owned' && a.project === b.project &&
  a.owner === b.owner && a.generation === b.generation && a.pairing === b.pairing;

export function projectCopyStatus(dataDir, spaceId, record) {
  const id = createHash('sha256').update(JSON.stringify([spaceId, record.project, record.owner, record.generation])).digest('hex');
  const file = join(dataDir, 'runner', 'project-copies', id + '.json');
  return {
    read() {
      const state = readJsonRecord(file, PROJECT_COPIES_FORMAT);
      return state?.spaceId === spaceId && sameOwner(record, state) ? state : null;
    },
    write(previous, fields) {
      const state = { ...previous, ...fields, version: 1, spaceId, project: record.project, state: record.state,
        owner: record.owner, generation: record.generation, pairing: record.pairing };
      writeVersionedJsonFileAtomic(file, state, PROJECT_COPIES_FORMAT, { durable: true });
      return state;
    }
  };
}

// One host process imports one scope at a time. The Provider separately holds
// its import lock, validates the envelope and refuses to cover any local data.
export function projectCopySync({ dataDir, spaceId, ownership, request, withLease, personal, now = Date.now,
  hold = async () => {
    const { holdPreparationLock } = await import('./follower-local-runtime.js');
    return holdPreparationLock(dataDir, { waitMs: 0 });
  } }) {
  let busy = false;
  const at = () => new Date(now()).toISOString();
  return async function sync(project, { signal } = {}) {
    if (busy) return { outcome: 'busy' };
    const record = ownership(project);
    if (record?.state !== 'owned') return { outcome: 'ownership_unverified' };
    const state = projectCopyStatus(dataDir, spaceId, record);
    const previous = state.read();
    const scope = 'project:' + project;
    const current = () => !signal?.aborted && sameOwner(record, ownership(project));
    const ask = (action, input) => request({ owner: record.owner, spaceId, scope, generation: record.generation,
      action, requestId: randomUUID(), ...(input ? { input } : {}) }, { signal });
    const save = fields => current() ? state.write(previous, { ...fields, attemptedAt: at() }) : { outcome: 'ownership_changed' };
    busy = true;
    try {
      const answer = await ask('export_digest');
      if (!answer.ok) return save({ outcome: answer.code === 'owner_offline' ? 'offline' : 'waiting' });
      const summary = answer.result;
      if (!summary?.ok || !validDigest(summary.digest)) {
        const reason = summary?.code || 'export_unverified';
        return save({ outcome: reason === 'owner_action_unavailable' ? 'waiting' : 'refused', reason });
      }
      if (!current()) return { outcome: 'ownership_changed' };
      if (previous?.blockedDigest === summary.digest && previous.outcome === 'refused') return previous;
      if (previous?.digest === summary.digest && validDigest(previous.contentDigest) && previous.dangling === 0 &&
        previous.outcome !== 'importing') {
        const stored = await withLease('runner-project-copy-check', () => personal.replicaSummary({ personalSpaceId: spaceId, scope }));
        if (stored.scope === scope && replicaContentMatches(previous, stored) &&
          stored.owners?.length === 1 && stored.owners[0] === record.owner) return save({ outcome: 'synced', checkedAt: at() });
      }
      const image = await readOwnerExport(ask, summary);
      if (!image.ok) return save({ outcome: 'waiting', reason: image.code });
      const release = await hold();
      if (!release) return { outcome: 'busy' };
      try { return await withLease('runner-project-copy-import', async () => {
        if (!current()) return { outcome: 'ownership_changed' };
        const proof = await personal.verifyProjectExport({ personalSpaceId: spaceId, projectId: project, envelope: image.text });
        if (!current() || proof?.spaceId !== spaceId || proof.project !== project || proof.digest !== summary.digest) {
          return save({ outcome: 'refused', reason: 'owner_scope_mismatch', blockedDigest: summary.digest });
        }
        save({ outcome: 'importing' });
        const imported = await personal.importScope({ envelope: image.text, owner: record.owner,
          generation: record.generation, pairing: record.pairing });
        if (imported?.owner !== record.owner || imported.scope !== scope || imported.digest !== summary.digest ||
          !validDigest(imported.contentDigest) || !Number.isSafeInteger(imported.dangling?.count) || imported.dangling.count < 0) {
          return save({ outcome: 'unverified_import' });
        }
        const complete = !imported.dangling.count;
        return save({ outcome: complete ? 'synced' : 'references_pending', checkedAt: at(), syncedAt: at(),
          digest: imported.digest, contentDigest: imported.contentDigest, dangling: imported.dangling.count });
      }); } finally { release(); }
    } catch (error) {
      if ([400,413,422].includes(error?.status)) return save({ outcome: 'refused', reason: 'copy_format_or_size' });
      return save({ outcome: 'waiting', reason: 'copy_unavailable' });
    }
    finally { busy = false; }
  };
}
