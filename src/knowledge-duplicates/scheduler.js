// The console host's periodic duplicate-merge pass (rec#88, after #839). The
// Provider merges a copy of current knowledge into one current item when it is
// written or confirmed; this pass catches what that missed: items stored
// before it existed, and copies in other words that only match once their
// meaning vectors arrive. The Provider decides every merge with strict rules,
// keeps the merged copy as history and lets a person split it back. One pass
// at a time, under the graph lease; a failed pass waits for the next tick.
const INTERVAL_MS = 30 * 60_000;

export function startDuplicateMerger({ app, withLease = (_owner, run) => run(), intervalMs = INTERVAL_MS }) {
  let running = false, stopped = false, active = null;
  const pass = async () => {
    if (stopped || running || app.getAgentAccessPolicy?.().enabled === false) return;
    running = true;
    try {
      await withLease('knowledge-duplicates', () => app.personal.mergeDuplicates({
        personalSpaceId: app.config.personal.spaceId }));
    } catch {
      // Nothing here is the person's to handle; the next tick tries again.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { if (!active) active = pass().finally(() => { active = null; }); }, intervalMs);
  timer.unref?.();
  // The pass in flight, or nothing: stopping with none in flight closes nothing late.
  return () => { stopped = true; clearInterval(timer); return active ?? undefined; };
}
