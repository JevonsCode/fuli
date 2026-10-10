import { randomUUID } from 'node:crypto';

// Owned by the console host only, never by every MCP process. A shared SQLite
// scope lease prevents overlap with manual reviews and other console instances.
export function startJudgmentScheduler({ app, withLease = (_owner, run) => run(), intervalMs = 300_000 }) {
  if (!app.judgment) return () => {};
  let running = false, active = null, stopped = false, backoffUntil = 0;
  const tick = async () => {
    if (stopped || running || Date.now() < backoffUntil
      || app.getAgentAccessPolicy?.().enabled === false
      || !app.judgment.store().hasAutomaticPolicy(app.config.personal.spaceId)) return;
    running = true;
    try {
      const result = await withLease('tonborg:review', () => app.judgment.reviewAutomatic({
        personalSpaceId: app.config.personal.spaceId, requestId: randomUUID(), limit: 10 }));
      if (result.records.some(record => record.outcome === 'failed')) backoffUntil = Date.now() + 900_000;
    } catch { backoffUntil = Date.now() + 900_000; }
    finally { running = false; }
  };
  const timer = setInterval(() => {
    if (!running && !stopped) active = tick();
  }, intervalMs);
  timer.unref?.();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
