// The reconciliation behind `fuli migrate reconcile-knowledge`, and the
// console's own re-check of it. A reconciler result alone is not proof: the
// graph's current watermark, read with the ordinary credential, decides
// whether the local stores are ready.
export async function reconcileAndVerify({ reconcile, gate, spaceId }) {
  await reconcile();
  const state = await gate.refresh(spaceId, { force: true });
  return state.state === 'open' ? { status: 'ready' } : { status: 'pending', reason: state.reason };
}

// How often a closed recovery gate may start another reconciliation.
const RECHECK_INTERVAL_MS = 15_000;

// The console checks again by itself when a request finds recovery pending,
// so the person never has to run the maintenance command: one run at a time,
// at most one start per interval. It runs what the console already runs when
// it starts (it holds the data directory's maintenance lock shared for its
// lifetime, as the command does while it runs); a run that fails leaves the
// gate closed. run wraps the work, e.g. in a graph runtime lease.
export function createKnowledgeRecoveryCheck({ reconcile, gate, spaceId, run = (work) => work(),
  now = () => performance.now(), intervalMs = RECHECK_INTERVAL_MS }) {
  let running = null;
  let startedAt = -Infinity;
  return {
    check() {
      const space = spaceId();
      if (running || !space || now() - startedAt < intervalMs) return running;
      startedAt = now();
      running = run(() => reconcileAndVerify({ reconcile, gate, spaceId: space }))
        .catch(() => ({ status: 'pending', reason: 'reconciliation_unavailable' }))
        .finally(() => { running = null; });
      return running;
    }
  };
}
