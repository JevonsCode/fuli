import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationError } from '../app/application-error.js';
import { HARD_DELETE_LEDGER_FILE, ledgerStamp, readHardDeleteProof } from './delete-ledger.js';

// Read by Agents and by the console (which shows its own wording); neither
// is told to run a command: the console re-checks by itself (recovery-check.js).
const WAIT = '等待图谱确认删除记录；FULI 控制台会自动重新核对，请稍后重试。 '
  + 'Waiting for deletion recovery; the FULI console checks again by itself, so try again shortly.';
const closed = reason => ({ state: 'closed', reason });
const open = Object.freeze({ state: 'open', reason: null });

export function assertKnowledgeRecovery(gate, spaceId, storeName) {
  if (gate?.state(spaceId, storeName)?.state !== 'open') {
    throw new ApplicationError('knowledge_recovery_pending', WAIT, { status: 503 });
  }
}

export async function prepareKnowledgeRecovery(gate, spaceId, storeName) {
  await gate.refresh(spaceId);
  assertKnowledgeRecovery(gate, spaceId, storeName);
}

// One process's proof of the current graph watermark, never a recovery writer.
// No timer opens a gate. A stale/mutated proof closes synchronously; a successful
// ordinary-token aggregate read must establish it again before any body access.
export function createKnowledgeRecoveryGate({ dataDir, readWatermark, now = () => performance.now(), maxAgeMs = 60_000,
  statFile = statSync }) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 60_000) throw new TypeError('Recovery proof lasts at most 60 seconds');
  const proofs = new Map();
  const pending = new Map();
  const file = join(dataDir, HARD_DELETE_LEDGER_FILE);
  function snapshot() {
    try {
      const stamp = ledgerStamp(file, statFile);
      return { stamp, document: readHardDeleteProof(dataDir) };
    } catch (error) {
      if (error.code === 'ENOENT') return { stamp: 'missing', document: null };
      throw error;
    }
  }
  function evaluate(document, watermark, spaceId) {
    if (document?.operations.some(operation => operation.spaceId === spaceId && operation.state === 'graph_deleted')) {
      return closed('local_cleanup_pending');
    }
    if (document === null) return watermark.count === 0 ? open : closed('ledger_missing');
    const local = document.watermarks?.[spaceId];
    if (!local) return closed('watermark_missing');
    return local.count === watermark.count && time(local.latestDeletedAt) === time(watermark.latest_deleted_at)
      ? open : closed('watermark_mismatch');
  }
  async function refresh(spaceId, { force = false } = {}) {
    if (typeof spaceId !== 'string' || !spaceId) throw new TypeError('Recovery needs a personal space');
    if (pending.has(spaceId)) return pending.get(spaceId);
    const operation = (async () => {
      let initial;
      try { initial = snapshot(); }
      catch { proofs.set(spaceId, { state: closed('ledger_invalid'), stamp: null, at: now() }); return closed('ledger_invalid'); }
      const cached = proofs.get(spaceId);
      if (!force && cached?.state.state === 'open' && cached.stamp === initial.stamp
          && now() - cached.at >= 0 && now() - cached.at < maxAgeMs) return cached.state;
      try {
        const watermark = await readWatermark({ personalSpaceId: spaceId });
        if (!validWatermark(watermark)) throw new TypeError('Invalid watermark');
        const latest = snapshot();
        if (latest.stamp !== initial.stamp) {
          proofs.delete(spaceId);
          return closed('ledger_changed');
        }
        const state = evaluate(latest.document, watermark, spaceId);
        proofs.set(spaceId, { state, stamp: latest.stamp, at: now() });
        return state;
      } catch {
        const state = closed('provider_unavailable');
        proofs.set(spaceId, { state, stamp: initial.stamp, at: now() });
        return state;
      }
    })();
    pending.set(spaceId, operation);
    try { return await operation; } finally { pending.delete(spaceId); }
  }
  function state(spaceId, _storeName) {
    let current;
    try { current = snapshot(); }
    catch { proofs.delete(spaceId); return closed('ledger_invalid'); }
    const proof = proofs.get(spaceId);
    if (!proof || proof.stamp !== current.stamp || now() - proof.at < 0 || now() - proof.at >= maxAgeMs) {
      void refresh(spaceId).catch(() => {});
      return closed('verification_pending');
    }
    // A pending/unknown operation keeps its ordinary item fence. It does not
    // close unrelated items. graph_deleted closes both stores until cleanup.
    if (current.document?.operations.some(operation => operation.spaceId === spaceId && operation.state === 'graph_deleted')) {
      return closed('local_cleanup_pending');
    }
    return proof.state;
  }
  return Object.freeze({ state, refresh });
}

function time(value) { return value === null ? null : Date.parse(value); }
function validWatermark(value) {
  return value && Object.keys(value).sort().join(',') === 'count,latest_deleted_at'
    && Number.isSafeInteger(value.count) && value.count >= 0
    && ((value.count === 0 && value.latest_deleted_at === null)
      || (value.count > 0 && typeof value.latest_deleted_at === 'string' && Number.isFinite(time(value.latest_deleted_at))));
}
