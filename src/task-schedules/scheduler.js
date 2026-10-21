// Owned by the console host only, never by every MCP process. One timer sleeps
// until the next due schedule (re-checked at least every 15 minutes, since
// another process can add schedules); due runs share the graph-runtime lease.
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;

export function startTaskScheduler({ app, withLease = (_owner, run) => run(), now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!app.taskSchedules) return async () => {};
  let timer = null, active = null, stopped = false;
  const delay = () => {
    let next;
    // A schedule store this version cannot use yet (rec#17) is retried later.
    try { next = app.taskSchedules.nextDueAt(); } catch { return MAX_DELAY_MS; }
    const wait = next ? new Date(next).getTime() - now() : MAX_DELAY_MS;
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, wait));
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimer(() => {
      active = (async () => {
        try {
          if (app.getAgentAccessPolicy?.().enabled !== false) {
            await withLease('task-schedules:run', () => app.taskSchedules.runDue());
          }
        } catch { /* A failed pass is retried on the next timer; runs are idempotent per slot. */ }
        finally { active = null; schedule(); }
      })();
    }, delay());
    timer.unref?.();
  };
  schedule();
  return async () => { stopped = true; clearTimer(timer); await active; };
}
