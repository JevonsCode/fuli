import { fillSemanticIndex, semanticModel } from './semantic-index.js';

// The console host fills the meaning index in the background, a pass every
// few minutes while a model is connected, and right away when asked (a person
// connected or changed the model). One pass at a time; the graph lease keeps
// it off a run that needs the graph to itself. A failed pass waits for the
// next tick: nothing here is the person's to handle.
const INTERVAL_MS = 3 * 60_000;

export function startSemanticIndexer({ app, withLease = (_owner, run) => run(), intervalMs = INTERVAL_MS }) {
  const state = { running: false, lastRun: null, model: null };
  let stopped = false, active = null;
  const pass = async () => {
    if (stopped || state.running || app.getAgentAccessPolicy?.().enabled === false) return;
    const model = semanticModel(app);
    state.model = model;
    if (!model) return;
    state.running = true;
    try {
      const result = await withLease('semantic-index', () => fillSemanticIndex(app));
      state.lastRun = { at: new Date().toISOString(), ...result };
    } catch {
      state.lastRun = { at: new Date().toISOString(), status: 'stopped' };
    } finally {
      state.running = false;
    }
  };
  // The pass in flight, or null: stopping with none in flight closes nothing late.
  const run = () => {
    if (!stopped && !active) active = pass().finally(() => { active = null; });
    return active;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return {
    state,
    runNow: run,
    stop() { stopped = true; clearInterval(timer); return active ?? undefined; }
  };
}

// What the top bar and the model page show: how much of the index is done for
// the connected model, and whether a pass is filling it now.
export async function semanticIndexStatus(app, indexer) {
  const model = semanticModel(app);
  if (!model) return { model: null, total: 0, done: 0, running: false };
  const status = await app.personal.semanticStatus({ personalSpaceId: app.config.personal.spaceId, model });
  return { model, total: status.total ?? 0, done: status.done ?? 0, running: Boolean(indexer?.state.running),
    lastRun: indexer?.state.lastRun ?? null };
}
