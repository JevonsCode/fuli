import { fillTerms, termsStats, trialTerms } from './fill.js';

// One retrieval-terms job at a time on this computer (rec#92): a self-test
// the person waits for, or a fill that runs in the background and can be
// stopped. Each project keeps its last self-test and fill to show again.
export function createTermsRunner({ app, withLease = (_owner, run) => run() }) {
  const trials = new Map();
  const runs = new Map();
  let active = null;

  const busy = () => (active ? { kind: active.kind, personalProjectId: active.personalProjectId } : null);

  async function trial(personalProjectId) {
    if (active) return { status: 'busy', busy: busy() };
    active = { kind: 'trial', personalProjectId };
    try {
      const result = await withLease('retrieval-terms', () => trialTerms(app, { personalProjectId }));
      if (result.status === 'tested') trials.set(personalProjectId, result);
      return result;
    } finally {
      active = null;
    }
  }

  function fill(personalProjectId) {
    if (active) return { status: 'busy', busy: busy() };
    const controller = new AbortController();
    const run = { status: 'running', personalProjectId, startedAt: new Date().toISOString(), written: 0, skipped: 0, tokens: 0 };
    runs.set(personalProjectId, run);
    active = { kind: 'fill', personalProjectId, controller };
    active.done = withLease('retrieval-terms', () => fillTerms(app, { personalProjectId, signal: controller.signal,
      onProgress: progress => Object.assign(run, progress) }))
      .then(result => Object.assign(run, result, { endedAt: new Date().toISOString() }))
      .catch(() => Object.assign(run, { status: 'model_failed', endedAt: new Date().toISOString() }))
      .finally(() => { active = null; });
    return run;
  }

  function stopFill() {
    active?.controller?.abort();
    return active?.done;
  }

  async function status(personalProjectId) {
    return { stats: await termsStats(app, personalProjectId).catch(() => null),
      trial: trials.get(personalProjectId) ?? null, run: runs.get(personalProjectId) ?? null, busy: busy() };
  }

  return { trial, fill, stop: stopFill, status, close: stopFill };
}
